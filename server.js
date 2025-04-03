const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();

// Basic CORS setup
app.use(cors({
  origin: true,
  credentials: true
}));

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple routes without pattern matching
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('Skribbl Game Server Running');
});

// Helper functions
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateId() {
  return uuidv4();
}

// Load dictionary
let words = [];
try {
  const dictionaryPath = path.join(__dirname, 'public', 'dictionary.json');
  const dictionaryContent = fs.readFileSync(dictionaryPath, 'utf8');
  words = JSON.parse(dictionaryContent);
  console.log(`Loaded ${words.length} words from dictionary.json`);
} catch (error) {
  console.error('Error loading dictionary.json:', error);
  words = [
    'apple', 'banana', 'orange', 'strawberry', 'grape',
    'car', 'bus', 'train', 'airplane', 'bicycle',
    'dog', 'cat', 'elephant', 'tiger', 'lion'
  ];
  console.log('Using fallback word list');
}

const server = http.createServer(app);

// Socket.IO setup with simplified configuration
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  },
  path: '/socket.io',
  serveClient: false,
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
});

// Initialize data structures
const usersByClientId = new Map(); // Track users by their clientId for better reconnection handling
const rooms = new Map();
const publicRooms = new Map(); // Track public rooms for browsing
const games = new Map();

// Helper function to find a user's room
function findUserRoom(userId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.some(p => p.id === userId)) {
      return roomId;
    }
  }
  return null;
}

// Helper function to find a room by clientId
function findRoomByClientId(clientId) {
  const user = usersByClientId.get(clientId);
  if (!user) return null;
  
  return findUserRoom(user.socketId);
}

function getRandomWords(count = 3) {
  const shuffled = [...words].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function createRoomState(isPublic = false, hostId, hostUsername, hostAvatar) {
  const roomId = isPublic ? uuidv4().substring(0, 6) : Math.random().toString(36).substring(2, 8).toUpperCase();
  
  console.log(`Creating room state with hostId: ${hostId}, username: ${hostUsername}`);
  
  const roomState = {
    id: roomId,
    isPublic,
    hostId,
    status: 'waiting',
    players: [],
    currentDrawer: null,
    word: '',
    wordOptions: [],
    timeLeft: 0,
    round: 0,
    totalRounds: 3,
    maxPlayers: 8,
    drawTime: 80,
    scores: {},
    hintsInterval: 2,
    gameMode: 'Normal',
    customWords: [],
    timer: null,
    drawingHistory: [],
    chatHistory: [],
    hintsRevealed: null
  };
  
  const hostPlayer = {
    id: hostId,
    username: hostUsername,
    score: 0,
    avatar: hostAvatar,
    isHost: true,
    isDrawing: false,
    hasGuessedCorrectly: false
  };
  
  roomState.players.push(hostPlayer);
  console.log(`Host player added:`, hostPlayer);
  
  rooms.set(roomId, roomState);
  
  if (isPublic) {
    publicRooms.set(roomId, {
      id: roomId,
      name: `${hostUsername}'s Room`,
      players: 1,
      maxPlayers: 8,
      inProgress: false
    });
  }
  
  return roomState;
}

function getPublicRoomsInfo() {
  return Array.from(publicRooms.values());
}

function updatePublicRoomInfo(roomId) {
  const room = rooms.get(roomId);
  
  if (!room || !room.isPublic) return;
  
  publicRooms.set(roomId, {
    id: roomId,
    name: `${room.players.find(p => p.isHost)?.username || 'Anonymous'}'s Room`,
    players: room.players.length,
    maxPlayers: room.maxPlayers || 8,
    inProgress: room.status !== 'waiting'
  });
}

function removePublicRoom(roomId) {
  publicRooms.delete(roomId);
}

function updatePublicRoomsList() {
  // Clear and rebuild the public rooms list
  publicRooms.clear();
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.isPublic) {
      updatePublicRoomInfo(roomId);
    }
  }
}

function startGameTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  clearInterval(room.timer);
  
  if (room.status === 'playing' && !room.hintsRevealed) {
    room.hintsRevealed = {
      count: 0,
      positions: []
    };
  }
  
  if (room.status === 'playing') {
    const totalDrawTime = room.drawTime + 10;
    const firstHintTime = Math.floor(totalDrawTime * 0.4);
    const secondHintTime = Math.floor(totalDrawTime * 0.7);
    
    room.hintTimes = {
      firstHint: room.timeLeft - firstHintTime,
      secondHint: room.timeLeft - secondHintTime
    };
    
    console.log(`Hint times set: First hint at ${room.hintTimes.firstHint}s, Second hint at ${room.hintTimes.secondHint}s`);
  }
  
  room.timer = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room) {
      clearInterval(room.timer);
      return;
    }
    
    room.timeLeft -= 1;
    
    io.to(roomId).emit('timeUpdate', { timeLeft: room.timeLeft });
    
    if (room.status === 'playing' && room.word && room.hintsRevealed && room.hintTimes) {
      if (room.timeLeft === room.hintTimes.firstHint && room.hintsRevealed.count === 0) {
        console.log(`Triggering first hint at ${room.timeLeft}s remaining`);
        revealHint(roomId, 1);
      }
      
      if (room.timeLeft === room.hintTimes.secondHint && room.hintsRevealed.count === 1) {
        console.log(`Triggering second hint at ${room.timeLeft}s remaining`);
        revealHint(roomId, 2);
      }
    }
    
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      
      if (room.status === 'selecting') {
        const randomWord = room.wordOptions[0];
        handleWordSelection(room, randomWord);
      } else if (room.status === 'playing') {
        endRound(roomId);
      }
    }
  }, 1000);
}

function revealHint(roomId, hintNumber) {
  const room = rooms.get(roomId);
  if (!room || !room.word || room.status !== 'playing') return;
  
  const word = room.word;
  const wordLength = word.length;
  
  let availablePositions = [];
  for (let i = 0; i < wordLength; i++) {
    if (word[i] !== ' ' && !room.hintsRevealed.positions.includes(i)) {
      availablePositions.push(i);
    }
  }
  
  if (availablePositions.length === 0) {
    console.log(`No more positions to reveal for hint ${hintNumber} in word "${room.word}"`);
    return;
  }
  
  availablePositions = availablePositions.sort(() => 0.5 - Math.random());
  
  const toReveal = hintNumber === 1 
    ? Math.max(1, Math.ceil(availablePositions.length * 0.25)) 
    : Math.max(1, Math.ceil(availablePositions.length * 0.5));
  
  const newRevealedPositions = availablePositions.slice(0, toReveal);
  
  room.hintsRevealed.positions = [...room.hintsRevealed.positions, ...newRevealedPositions];
  room.hintsRevealed.count = hintNumber;
  
  const maskedWord = generateMaskedWordWithHints(room.word, room.hintsRevealed.positions);
  
  room.players.forEach(player => {
    if (!player.hasGuessedCorrectly && player.id !== room.currentDrawer) {
      io.to(player.id).emit('wordHint', { 
        hint: maskedWord,
        hintNumber
      });
    }
  });
  
  console.log(`Hint ${hintNumber} revealed for word "${room.word}" in room ${roomId}: ${maskedWord} (revealed positions: ${newRevealedPositions.join(', ')})`);
}

function generateMaskedWordWithHints(word, revealedPositions) {
  return word.split('').map((char, index) => {
    if (char === ' ') return ' ';
    if (revealedPositions.includes(index)) return char;
    return '_';
  }).join('');
}

function levenshteinDistance(a, b) {
  const matrix = [];
  
  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1, // substitution
          matrix[i][j-1] + 1,   // insertion
          matrix[i-1][j] + 1    // deletion
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

function startRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  io.to(roomId).emit('canvasCleared');
  console.log(`Clearing canvas for all players in room ${roomId}`);
  
  if (room.status === 'roundEnd' || room.status === 'waiting') {
    room.round += 1;
  }
  
  if (room.round > room.totalRounds) {
    endGame(roomId);
    return;
  }
  
  const currentDrawerIndex = room.currentDrawer 
    ? room.players.findIndex(p => p.id === room.currentDrawer)
    : -1;
  
  const nextDrawerIndex = (currentDrawerIndex + 1) % room.players.length;
  const nextDrawer = room.players[nextDrawerIndex];
  
  // Mark each player's drawing status
  room.players.forEach(player => {
    player.isDrawing = player.id === nextDrawer.id;
    player.hasGuessedCorrectly = false;
    
    // Track if this player has been a drawer before
    if (player.id === nextDrawer.id) {
      player.hasBeenDrawer = true;
    }
  });
  
  room.drawingHistory = [];
  
  room.currentDrawer = nextDrawer.id;
  room.currentDrawerName = nextDrawer.username;
  room.status = 'selecting';
  room.word = '';
  
  const wordSource = room.gameMode === 'Custom Words' && room.customWords.length >= 3
    ? room.customWords
    : words;
  
  room.wordOptions = getRandomWords(3);
  
  room.timeLeft = 15;
  
  updatePublicRoomInfo(roomId);
  
  console.log(`Starting round ${room.round} with drawer: ${nextDrawer.username} (${nextDrawer.id})`);
  
  io.to(roomId).emit('gameStarted', { 
    round: room.round,
    totalRounds: room.totalRounds,
    drawer: {
      id: nextDrawer.id,
      username: nextDrawer.username
    }
  });
  
  io.to(nextDrawer.id).emit('wordSelection', { 
    words: room.wordOptions,
    isDrawing: true
  });
  
  startGameTimer(roomId);
}

function handleWordSelection(room, selectedWord) {
  if (!room || !selectedWord) return;
  
  const drawerPlayer = room.players.find(p => p.id === room.currentDrawer);
  if (!drawerPlayer) {
    console.error(`Drawer player not found for ID: ${room.currentDrawer}`);
    return;
  }
  
  console.log(`Word selected: ${selectedWord} by ${drawerPlayer.username}`);
  
  io.to(room.id).emit('canvasCleared');
  
  room.word = selectedWord;
  room.status = 'playing';
  
  room.hintsRevealed = {
    count: 0,
    positions: []
  };
  
  room.timeLeft = room.drawTime + 10;
  
  room.drawingHistory = [];
  
  const hiddenWord = selectedWord.split('').map(char => char === ' ' ? ' ' : '_').join('');
  
  // Send to all players in the room
  room.players.forEach(player => {
    if (player.id === room.currentDrawer) {
      io.to(player.id).emit('roundStart', {
        gameState: 'playing',
        drawer: room.currentDrawer,
        drawerName: drawerPlayer.username,
        word: selectedWord,
        timeLeft: room.timeLeft,
        isDrawing: true
      });
    } else {
      io.to(player.id).emit('roundStart', {
        gameState: 'playing',
        drawer: room.currentDrawer,
        drawerName: drawerPlayer.username,
        timeLeft: room.timeLeft,
        word: hiddenWord,
        isDrawing: false
      });
    }
  });
  
  console.log(`Round started in room ${room.id} with word: ${selectedWord}, drawer: ${drawerPlayer.username}`);
  
  startGameTimer(room.id);
}

function endRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  clearInterval(room.timer);
  
  room.status = 'roundEnd';
  
  const someoneGuessed = room.players.some(p => p.id !== room.currentDrawer && p.hasGuessedCorrectly);
  if (someoneGuessed) {
    const drawer = room.players.find(p => p.id === room.currentDrawer);
    if (drawer) {
      drawer.score += 25;
    }
  }
  
  io.to(roomId).emit('canvasCleared');
  
  room.drawingHistory = [];
  
  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
  const isGameOver = room.round >= room.totalRounds && 
                    room.players.every(p => p.isDrawing || p.hasBeenDrawer);
  
  io.to(roomId).emit('roundEnded', {
    word: room.word,
    players: sortedPlayers,
    isLastRound: isGameOver
  });
  
  console.log(`Round ended in room ${roomId}. Waiting 5 seconds before next round.`);
  
  setTimeout(() => {
    if (rooms.has(roomId)) {
      if (isGameOver) {
        endGame(roomId);
      } else {
        startRound(roomId);
      }
    }
  }, 5000);
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  clearInterval(room.timer);
  
  room.status = 'gameEnd';
  
  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
  
  io.to(roomId).emit('gameEnded', {
    players: sortedPlayers
  });
  
  updatePublicRoomInfo(roomId);
}

// Room cleanup interval (5 minutes)
const ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000;

// Handle initial connection
io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);
  let username = socket.handshake.query.username;
  const clientId = socket.handshake.query.clientId;
  
  // Store connection status in socket data
  socket.data.isConnected = true;
  socket.data.clientId = clientId;
  
  if (username) {
    username = decodeURIComponent(username.replace(/\+/g, ' '));
    console.log(`Client connected - ID: ${clientId}, Username: ${username}`);
    socket.data.username = username;
  }
  
  // Check if this is a reconnection
  if (clientId && usersByClientId.has(clientId)) {
    const userData = usersByClientId.get(clientId);
    const oldSocketId = userData.socketId;
    
    console.log(`Reconnection detected. Old socket: ${oldSocketId}, New socket: ${socket.id}`);
    
    // Update socket ID in the userData
    userData.socketId = socket.id;
    userData.isConnected = true;
    userData.lastConnected = Date.now();
    
    // Find which room the user was in
    const roomId = findUserRoom(oldSocketId);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        // Update player entry with new socket ID
        const playerIndex = room.players.findIndex(p => p.id === oldSocketId);
        if (playerIndex !== -1) {
          console.log(`Updating player in room ${roomId} from ${oldSocketId} to ${socket.id}`);
          
          // Update the player ID and connection status
          room.players[playerIndex].id = socket.id;
          room.players[playerIndex].isConnected = true;
          
          // Join the socket to the room
          socket.join(roomId);
          
          // Notify all clients about the updated player list
          io.to(roomId).emit('playerStatus', { 
            players: room.players
          });
        }
      }
    }
  }
  
  // Send connection acknowledgment
  socket.emit('connectionAck', {
    socketId: socket.id,
    clientId: clientId
  });
  
  socket.on('setUsername', (data) => {
    let newUsername = typeof data === 'string' ? data : data.username;
    newUsername = newUsername.trim();
    
    console.log(`Setting username for ${socket.id}: ${newUsername}`);
    socket.data.username = newUsername;
    
    // Store in the client ID map for reconnection
    if (clientId) {
      if (usersByClientId.has(clientId)) {
        console.log(`Found existing session for client ${clientId}`);
      }
      
      usersByClientId.set(clientId, {
        socketId: socket.id,
        username: newUsername,
        avatar: data.avatar || Math.floor(Math.random() * 10),
        isConnected: true,
        lastConnected: Date.now()
      });
    }
    
    // Confirm username is set
    socket.emit('usernameSet', {
      username: newUsername,
      avatar: data.avatar || Math.floor(Math.random() * 10)
    });
    
    // Check if user was in a room
    const roomId = findRoomByClientId(clientId);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        console.log(`User ${newUsername} was in room ${roomId}, prompting rejoin`);
        socket.emit('rejoinPrompt', {
          roomId,
          username: newUsername
        });
      }
    }
  });
  
  socket.on('createRoom', (data) => {
    if (!socket.data.username && (!data || !data.username)) {
      socket.emit('errorMessage', 'Username not set');
      return;
    }
    
    const username = socket.data.username || data.username;
    // Default to false for isPrivate/isPublic if not explicitly set
    // If isPrivate is false, the room is public
    // If isPrivate is undefined but isPublic is true, the room is public
    const isPublic = data?.isPrivate === false || data?.isPublic === true;
    
    console.log(`Creating room request from ${username} (${socket.id}), isPublic: ${isPublic}`);
    
    // Check if player is already in a room
    const existingRoomId = findUserRoom(socket.id);
    if (existingRoomId) {
      // Clean up from the existing room
      leaveRoom(socket, existingRoomId);
    }
    
    // Generate unique room ID
    const roomId = generateRoomId();
    console.log(`Creating room state with hostId: ${socket.id}, username: ${username}`);
    
    // Create room state
    const roomState = {
      id: roomId,
      hostId: socket.id,
      isPublic: isPublic,
      players: [],
      gameStarted: false,
      lastActivity: Date.now(),
      status: 'waiting',
      maxPlayers: 8,
      drawTime: 80,
      round: 0,
      totalRounds: 3
    };
    
    // Add host as first player
    const hostPlayer = {
      id: socket.id,
      username: username,
      score: 0,
      avatar: data.avatar || Math.floor(Math.random() * 10),
      isHost: true,
      isDrawing: false,
      hasGuessedCorrectly: false,
      isConnected: true
    };
    
    console.log('Host player added:', hostPlayer);
    roomState.players.push(hostPlayer);
    rooms.set(roomId, roomState);
    console.log(`Room state created with ID: ${roomId}`);
    
    // Explicitly join the socket to the room
    socket.join(roomId);
    console.log(`Explicitly joining socket ${socket.id} to room ${roomId}`);
    
    // Store room info in user data
    if (clientId) {
      const userData = usersByClientId.get(clientId);
      if (userData) {
        userData.currentRoom = roomId;
      }
    }
    
    // Send room created event to creator
    console.log(`Emitting roomCreated for roomId: ${roomId}`);
    socket.emit('roomCreated', { roomId });
    
    // Send joined room event to creator with player list
    console.log(`Emitting joinedRoom for roomId: ${roomId}`);
    socket.emit('joinedRoom', {
      roomId,
      players: roomState.players
    });
    
    console.log(`Room created: ${roomId}, Public: ${isPublic}, Host: ${username}`);
    
    // Update public rooms list if the room is public
    if (isPublic) {
      updatePublicRoomInfo(roomId);
      console.log(`Added room ${roomId} to public rooms list`);
      console.log('Current public rooms:', getPublicRoomsInfo());
    }
  });
  
  socket.on('joinRoom', (data) => {
    if (!socket.data.username && (!data || !data.username)) {
      socket.emit('errorMessage', 'Username not set');
      return;
    }
    
    const roomIdToJoin = typeof data === 'string' ? data : data.roomId;
    
    if (!rooms.has(roomIdToJoin)) {
      socket.emit('errorMessage', 'Room not found');
      return;
    }
    
    const room = rooms.get(roomIdToJoin);
    const username = socket.data.username || data.username;
    const avatar = data.avatar || Math.floor(Math.random() * 10);
    
    console.log(`Player ${username} joining room: ${roomIdToJoin}`);
    
    // Check if player is already in the room
    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (existingPlayer) {
      console.log(`Player ${username} is already in room ${roomIdToJoin}`);
      
      // Update connection status
      existingPlayer.isConnected = true;
      
      // Rejoin the socket to the room to ensure proper connection
      socket.join(roomIdToJoin);
      
      // Send current state to the player
      socket.emit('joinedRoom', {
        roomId: roomIdToJoin,
        players: room.players
      });
      
      // Notify all clients about the player reconnection
      io.to(roomIdToJoin).emit('playerStatus', {
        players: room.players
      });
      
      return;
    }
    
    // Check if player is in another room
    const existingRoomId = findUserRoom(socket.id);
    if (existingRoomId && existingRoomId !== roomIdToJoin) {
      leaveRoom(socket, existingRoomId);
    }
    
    // Create new player
    const newPlayer = {
      id: socket.id,
      username: username,
      score: 0,
      avatar: avatar,
      isHost: false,
      isDrawing: false,
      hasGuessedCorrectly: false,
      isConnected: true
    };
    
    // Add player to room
    room.players.push(newPlayer);
    
    // Join socket to room
    socket.join(roomIdToJoin);
    
    // Store room info in user data
    if (clientId) {
      const userData = usersByClientId.get(clientId);
      if (userData) {
        userData.currentRoom = roomIdToJoin;
      }
    }
    
    // Broadcast to all players in the room
    io.to(roomIdToJoin).emit('playerJoined', {
      players: room.players
    });
    
    // Send room info to the new player
    socket.emit('joinedRoom', {
      roomId: roomIdToJoin,
      players: room.players
    });
    
    console.log(`Player ${username} joined room: ${roomIdToJoin}`);
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected - Socket: ${socket.id}, Reason: ${reason}`);
    
    // Find which room the user was in
    const roomId = findUserRoom(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        console.log(`User disconnected: ${socket.id} from room: ${roomId}`);
        
        // Update player connection status but don't remove them immediately
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          room.players[playerIndex].isConnected = false;
          
          // Store disconnect timestamp
          room.players[playerIndex].disconnectedAt = Date.now();
          
          // Update the client ID map
          if (clientId && usersByClientId.has(clientId)) {
            const userData = usersByClientId.get(clientId);
            userData.isConnected = false;
            userData.lastDisconnected = Date.now();
            userData.socketId = socket.id; // Keep the ID for reconnection
          }
          
          // Broadcast updated player list
          io.to(roomId).emit('playerStatus', {
            players: room.players
          });
          
          // Set a timer to remove the player if they don't reconnect
          setTimeout(() => {
            // Check if player still exists and is still disconnected
            const currentRoom = rooms.get(roomId);
            if (currentRoom) {
              const player = currentRoom.players.find(p => p.id === socket.id);
              if (player && !player.isConnected) {
                handlePlayerLeave(socket, roomId);
              }
            }
          }, 30000); // 30 seconds grace period
        }
      }
    }
  });

  // Function to handle player leaving a room
  function handlePlayerLeave(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    console.log(`Removing player ${socket.id} from room ${roomId}`);
    
    // Remove player from the room
    room.players = room.players.filter(player => player.id !== socket.id);
    
    // If room is empty, delete it
    if (room.players.length === 0) {
      rooms.delete(roomId);
      console.log(`Room deleted: ${roomId}`);
      updatePublicRoomsList();
      return;
    }
    
    // If the host left, assign a new host
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.players[0].isHost = true;
    }
    
    // Broadcast updated player list
    io.to(roomId).emit('playerLeft', {
      players: room.players
    });
    
    updatePublicRoomsList();
  }
  
  // Function to handle leaving a room
  function leaveRoom(socket, roomId) {
    handlePlayerLeave(socket, roomId);
    socket.leave(roomId);
  }
  
  socket.on('leaveRoom', () => {
    const roomId = findUserRoom(socket.id);
    if (roomId) {
      leaveRoom(socket, roomId);
    }
  });
  
  socket.on('getPublicRooms', () => {
    console.log(`Socket ${socket.id} requested public rooms`);
    const publicRoomsInfo = getPublicRoomsInfo();
    console.log(`Sending ${publicRoomsInfo.length} public rooms:`, publicRoomsInfo);
    socket.emit('publicRooms', publicRoomsInfo);
  });
  
  socket.on('startGame', (settings) => {
    try {
      // Get room directly from socket ID instead of user clientId map
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        socket.emit('errorMessage', 'You are not in a room');
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found with ID:', roomId);
        socket.emit('errorMessage', 'Room not found');
        return;
      }
      
      // Get player from room players list
      const playerObj = room.players.find(p => p.id === socket.id);
      if (!playerObj) {
        console.error(`Player not found in room ${roomId} for socket ${socket.id}`);
        socket.emit('errorMessage', 'Player not found in room');
        return;
      }
      
      console.log(`Start game request from ${playerObj.username} (${socket.id})`);
      console.log(`Player object:`, playerObj);
      console.log(`Room hostId: ${room.hostId}, Room players:`, room.players);
      
      if (!playerObj.isHost) {
        console.error(`User ${playerObj.username} (${socket.id}) is not the host`);
        socket.emit('errorMessage', 'Only the host can start the game');
        return;
      }
      
      if (room.players.length < 2) {
        socket.emit('errorMessage', 'Need at least 2 players to start');
        return;
      }
      
      console.log(`Starting game in room ${roomId} with settings:`, settings);
      
      // Apply settings to room
      room.status = 'waiting';
      room.totalRounds = settings?.rounds || 3;
      room.drawTime = settings?.drawTime || 80;
      room.maxPlayers = settings?.maxPlayers || 8;
      room.gameMode = settings?.gameMode || 'Normal';
      room.hintsInterval = settings?.hintsInterval || 2;
      
      if (settings?.customWords && room.gameMode === 'Custom Words') {
        const customWordsList = settings.customWords
          .split(',')
          .map(word => word.trim().toLowerCase())
          .filter(word => word.length > 0 && word.length <= 30);
        
        if (customWordsList.length < 3) {
          socket.emit('errorMessage', 'Need at least 3 custom words');
          return;
        }
        
        room.customWords = customWordsList;
      }
      
      room.players.forEach(player => {
        player.score = 0;
        player.isDrawing = false;
        player.hasGuessedCorrectly = false;
      });
      
      room.round = 0;
      
      updatePublicRoomInfo(roomId);
      
      startRound(roomId);
      
      console.log(`Game started in room: ${roomId}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('errorMessage', 'Failed to start game: ' + error.message);
    }
  });
  
  socket.on('selectWord', ({ word }) => {
    try {
      // Get room directly from socket ID
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found with ID:', roomId);
        return;
      }
      
      if (room.currentDrawer !== socket.id || room.status !== 'selecting') {
        console.error(`User ${socket.id} is not the current drawer or room is not in selecting state`);
        return;
      }
      
      handleWordSelection(room, word);
      
      console.log(`Word selected in room ${roomId}: ${word}`);
    } catch (error) {
      console.error('Error selecting word:', error);
    }
  });
  
  socket.on('chatMessage', ({ message }) => {
    try {
      // Get room directly from socket ID
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found with ID:', roomId);
        return;
      }
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player) {
        console.error(`Player not found in room ${roomId}`);
        return;
      }
      
      if (!room.chatHistory) {
        room.chatHistory = [];
      }
      
      // If the player is drawing, they can send normal messages to everyone
      if (player.isDrawing) {
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: player.username,
          message,
          timestamp: Date.now()
        };
        
        room.chatHistory.push(chatMessage);
        
        if (room.chatHistory.length > 100) {
          room.chatHistory.shift();
        }
        
        io.to(roomId).emit('chatMessage', chatMessage);
        return;
      }
      
      // If player already guessed correctly, their messages are only seen by other correct guessers and the drawer
      if (player.hasGuessedCorrectly) {
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: player.username,
          message,
          timestamp: Date.now(),
          fromPlayerWhoGuessed: true
        };
        
        room.chatHistory.push(chatMessage);
        
        if (room.chatHistory.length > 100) {
          room.chatHistory.shift();
        }
        
        room.players.forEach(p => {
          if (p.hasGuessedCorrectly || p.isDrawing) {
            io.to(p.id).emit('chatMessage', chatMessage);
          }
        });
        return;
      }
      
      // For players still guessing during gameplay
      if (room.status === 'playing') {
        const normalizedGuess = message.toLowerCase().trim();
        const normalizedWord = room.word.toLowerCase().trim();
        
        // Check if the guess is correct
        if (normalizedGuess === normalizedWord || 
            (normalizedGuess.length > 3 && levenshteinDistance(normalizedGuess, normalizedWord) <= 1)) {
          player.hasGuessedCorrectly = true;
          
          const scoreGain = Math.ceil((room.timeLeft / room.drawTime) * 100) + 50;
          player.score += scoreGain;
          
          const correctGuessMessage = {
            id: uuidv4(),
            playerId: 'system',
            username: 'System',
            message: `${player.username} guessed the word!`,
            isSystemMessage: true,
            isCorrectGuess: true,
            timestamp: Date.now()
          };
          
          room.chatHistory.push(correctGuessMessage);
          
          if (room.chatHistory.length > 100) {
            room.chatHistory.shift();
          }
          
          io.to(roomId).emit('chatMessage', correctGuessMessage);
          
          io.to(roomId).emit('playerJoined', { 
            players: room.players
          });
          
          io.to(socket.id).emit('wordGuessed', {
            word: room.word
          });
          
          const allNonDrawersGuessed = room.players.filter(p => !p.disconnected).every(p => 
            p.id === room.currentDrawer || p.hasGuessedCorrectly || p.disconnected);
          
          if (allNonDrawersGuessed) {
            clearInterval(room.timer);
            
            setTimeout(() => {
              endRound(roomId);
            }, 1500);
          }
        } else {
          // The guess is incorrect - create a regular message
          const chatMessage = {
            id: uuidv4(),
            playerId: socket.id,
            username: player.username,
            message,
            timestamp: Date.now()
          };
          
          room.chatHistory.push(chatMessage);
          
          if (room.chatHistory.length > 100) {
            room.chatHistory.shift();
          }
          
          // Send this message to all players who haven't guessed correctly AND all players who have guessed correctly
          room.players.forEach(p => {
            // All players who have guessed correctly can see all messages
            // Players who are still guessing can only see messages from other guessers and the drawer
            if (p.hasGuessedCorrectly || p.isDrawing || !p.hasGuessedCorrectly) {
              io.to(p.id).emit('chatMessage', chatMessage);
            }
          });
        }
      } else {
        // For non-gameplay states, everyone sees all messages
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: player.username,
          message,
          timestamp: Date.now()
        };
        
        room.chatHistory.push(chatMessage);
        
        if (room.chatHistory.length > 100) {
          room.chatHistory.shift();
        }
        
        io.to(roomId).emit('chatMessage', chatMessage);
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });
  
  socket.on('drawing', (data) => {
    try {
      // Get room directly from socket ID
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found with ID:', roomId);
        return;
      }
      
      if (room.currentDrawer !== socket.id || room.status !== 'playing') {
        console.error(`User ${socket.id} is not the current drawer or room is not in playing state`);
        return;
      }
      
      // Enhanced logging for drawing data
      console.log(`Received drawing data from ${socket.id} to room ${roomId}:`, 
        data.type === 'clear' ? 'CLEAR CANVAS' : `Line (${data.x0},${data.y0}) to (${data.x1},${data.y1})`);
      
      // Store drawing history for future players who join
      if (data.type !== 'clear') {
        room.drawingHistory.push(data);
      } else {
        // If it's a clear command, clear the history
        room.drawingHistory = [];
      }
      
      // Broadcast drawing data to all other players in the room
      socket.to(roomId).emit('drawingData', data);
    } catch (error) {
      console.error('Error handling drawing data:', error);
    }
  });
  
  socket.on('clearCanvas', () => {
    try {
      // Get room directly from socket ID
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found with ID:', roomId);
        return;
      }
      
      if (room.currentDrawer !== socket.id || room.status !== 'playing') {
        console.error(`User ${socket.id} is not the current drawer or room is not in playing state`);
        return;
      }
      
      console.log(`Clearing canvas in room ${roomId} by ${socket.id}`);
      room.drawingHistory = []; // Clear drawing history
      
      // Broadcast canvas clear to all clients including the sender
      io.to(roomId).emit('canvasCleared');
    } catch (error) {
      console.error('Error handling clear canvas:', error);
    }
  });
});

// Regular cleanup function to check for inactive rooms and disconnected players
setInterval(() => {
  const now = Date.now();
  
  // Clean up rooms with no activity
  for (const [roomId, room] of rooms.entries()) {
    // Remove disconnected players after 2 minutes
    room.players = room.players.filter(player => {
      if (!player.isConnected && player.disconnectedAt && (now - player.disconnectedAt > 120000)) {
        console.log(`Removing inactive player ${player.username} from room ${roomId}`);
        return false;
      }
      return true;
    });
    
    // If room is empty or inactive for 30 minutes, delete it
    if (room.players.length === 0 || (now - room.lastActivity > 1800000)) {
      console.log(`Deleting inactive room: ${roomId}`);
      rooms.delete(roomId);
    }
  }
  
  // Clean up user session data older than 1 hour
  for (const [clientId, userData] of usersByClientId.entries()) {
    if (!userData.isConnected && userData.lastDisconnected && (now - userData.lastDisconnected > 3600000)) {
      console.log(`Cleaning up stale user session for client ${clientId}`);
      usersByClientId.delete(clientId);
    }
  }
  
  // Update public rooms list
  updatePublicRoomsList();
}, 60000); // Run every minute

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = server; 