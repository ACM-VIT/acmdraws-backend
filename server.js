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
  const roomId = generateRoomId();
  
  console.log(`Creating room state with hostId: ${hostId}, username: ${hostUsername}`);
  
  const roomState = {
    id: roomId,
    isPublic: isPublic, // Explicitly set isPublic flag
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
    hintsRevealed: null,
    lastActivity: Date.now()
  };
  
  const hostPlayer = {
    id: hostId,
    username: hostUsername,
    score: 0,
    avatar: hostAvatar,
    isHost: true,
    isDrawing: false,
    hasGuessedCorrectly: false,
    isConnected: true
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
    console.log(`Added room ${roomId} to public rooms list. isPublic: ${isPublic}`);
  } else {
    console.log(`Room ${roomId} not added to public rooms. isPublic: ${isPublic}`);
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
  
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  
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
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) {
        clearInterval(room.timer);
        return;
      }
      
      clearInterval(currentRoom.timer);
      currentRoom.timer = null;
      
      if (currentRoom.status === 'selecting') {
        const randomWord = currentRoom.wordOptions[0];
        handleWordSelection(currentRoom, randomWord);
      } else if (currentRoom.status === 'playing') {
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
  
  // Send hints to all applicable players
  for (const player of room.players) {
    // The drawer and players who already guessed correctly don't get hints
    // They already know the word
    if (player.id === room.currentDrawer.id || player.hasGuessedCorrectly) {
      continue;
    }
    
    // Send the masked word with hints to this player
    io.to(player.id).emit('wordHint', { 
      hint: maskedWord,
      hintNumber
    });
  }
  
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
  
  // Clear existing timers
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  
  // Check if all players have drawn in this round
  const allPlayersHaveDrawn = room.players.every(player => {
    return player.hasDrawnThisRound === true || !player.isConnected;
  });
  
  // If all players have had their turn, start a new round
  if (allPlayersHaveDrawn) {
    // Reset hasDrawnThisRound flag for all players
    room.players.forEach(player => {
      player.hasDrawnThisRound = false;
    });
    
    // Increment round number
    room.round++;
    
    // End game if we've completed all rounds
    if (room.round > room.totalRounds) {
      return endGame(roomId);
    }
    
    // Send round info to clients
    io.to(roomId).emit('roundInfo', {
      round: room.round,
      totalRounds: room.totalRounds
    });
  }
  
  console.log(`Starting round ${room.round} in room ${roomId}`);
  
  // Reset all players' states
  room.players.forEach(player => {
    player.isDrawing = false;
    player.hasGuessedCorrectly = false;
  });
  
  // Choose next drawer among players who haven't drawn in this round
  const eligibleDrawers = room.players.filter(player => 
    !player.hasDrawnThisRound && player.isConnected
  );
  
  // If no eligible drawers, this shouldn't happen, but handle it
  if (eligibleDrawers.length === 0) {
    console.error(`No eligible drawers in room ${roomId}`);
    return endGame(roomId);
  }
  
  // Select next drawer - preferring the host for the first turn
  let nextDrawer;
  if (room.round === 1 && !room.playerHasDrawn && room.players.some(p => p.isHost && p.isConnected)) {
    nextDrawer = room.players.find(p => p.isHost && p.isConnected);
  } else {
    nextDrawer = eligibleDrawers[0]; // Just take the first eligible drawer
  }
  
  // Mark as drawing
  nextDrawer.isDrawing = true;
  nextDrawer.hasDrawnThisRound = true;
  room.currentDrawer = nextDrawer;
  
  // Track that at least one player has drawn
  room.playerHasDrawn = true;
  
  // Clear canvas for everyone
  io.to(roomId).emit('canvasCleared');
  
  // Give word options to the drawer
  let wordOptions;
  if (room.gameMode === 'Custom Words' && room.customWords && room.customWords.length >= 3) {
    wordOptions = [...room.customWords].sort(() => 0.5 - Math.random()).slice(0, 3);
  } else {
    wordOptions = getRandomWords(3);
  }
  
  room.wordOptions = wordOptions;
  room.status = 'selecting';
  room.timeLeft = 15; // 15 seconds to select a word
  
  // Send word selection to drawer
  io.to(nextDrawer.id).emit('wordSelection', { words: wordOptions });
  
  // Let everyone know who's drawing now
  io.to(roomId).emit('gameStarted', {
    round: room.round,
    totalRounds: room.totalRounds,
    drawer: {
      id: nextDrawer.id,
      username: nextDrawer.username
    }
  });

  // Also notify other players that someone is selecting a word
  io.to(roomId).emit('playerSelecting', {
    drawer: nextDrawer.id,
    drawerName: nextDrawer.username
  });
  
  console.log(`Player ${nextDrawer.username} is now drawing in room ${roomId}`);
  
  // Start the timer for word selection
  startGameTimer(roomId);
  
  // Update public room info
  if (room.isPublic) {
    updatePublicRoomInfo(roomId);
  }
}

function handleWordSelection(room, selectedWord) {
  if (!room || !selectedWord) return;
  
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  
  room.word = selectedWord;
  room.status = 'playing';
  room.timeLeft = room.drawTime || 80;
  room.hintsRevealed = {
    count: 0,
    positions: []
  };
  
  console.log(`Word selected in room ${room.id}: ${selectedWord}`);
  
  // Clear canvas for everyone
  io.to(room.id).emit('canvasCleared');
  
  // Reset drawing history
  room.drawingHistory = [];
  
  // Send to all clients that the round is starting
  for (const player of room.players) {
    const isDrawer = player.id === room.currentDrawer.id;
    const wordToSend = isDrawer ? selectedWord : selectedWord.replace(/[a-zA-Z]/g, '_');
    
    // Send current word state to each player
    io.to(player.id).emit('roundStart', {
      drawer: room.currentDrawer.id,
      drawerName: room.currentDrawer.username,
      word: wordToSend,
      timeLeft: room.timeLeft,
      isDrawing: isDrawer
    });
    
    // Ensure non-drawers get the masked word as hint
    if (!isDrawer) {
      io.to(player.id).emit('wordHint', { 
        hint: wordToSend,
        hintNumber: 0
      });
    }
  }
  
  // Start timer for the actual drawing round
  startGameTimer(room.id);
}

function endRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  console.log(`Ending round in room ${roomId}, word was: ${room.word}`);
  
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  
  // Check if all players have drawn in this round
  const allPlayersHaveDrawn = room.players.every(player => {
    return player.hasDrawnThisRound === true || !player.isConnected;
  });
  
  // Update everyone's scores
  for (const player of room.players) {
    // Reset for next round
    player.hasGuessedCorrectly = false;
    player.isDrawing = false;
  }
  
  // Send end of round data with updated player list
  io.to(roomId).emit('roundEnded', {
    word: room.word,
    players: room.players,
    isLastRound: room.round >= room.totalRounds && allPlayersHaveDrawn,
    round: room.round,
    totalRounds: room.totalRounds
  });
  
  // Add a short delay before starting next round
  setTimeout(() => {
    // Check if all players have drawn in this round
    if (allPlayersHaveDrawn) {
      // All players have drawn in this round
      // Check if this was the last round
      if (room.round >= room.totalRounds) {
        // Game over
        endGame(roomId);
      } else {
        // Start new round
        startRound(roomId);
      }
    } else {
      // Continue with next drawer in this round
      startRound(roomId);
    }
  }, 5000); // 5 second delay between rounds
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

// Function to handle player leaving a room
function handlePlayerLeave(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  console.log(`Removing player ${socket.id} from room ${roomId}`);
  
  // Check if this player was the current drawer
  const wasDrawing = room.currentDrawer && room.currentDrawer.id === socket.id;
  const leavingPlayer = room.players.find(player => player.id === socket.id);
  const leavingPlayerName = leavingPlayer ? leavingPlayer.username : 'Player';
  
  // Remove player from the room
  room.players = room.players.filter(player => player.id !== socket.id);
  
  // If room is empty, delete it
  if (room.players.length === 0) {
    // Store the timer before deleting the room
    const roomTimer = room.timer;
    
    // Delete the room
    rooms.delete(roomId);
    
    // Clear the timer after the room is deleted
    if (roomTimer) {
      clearInterval(roomTimer);
    }
    
    console.log(`Room deleted: ${roomId}`);
    updatePublicRoomsList();
    return;
  }
  
  // If the host left, assign a new host
  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
  }
  
  // Special handling if the player who left was drawing
  if (wasDrawing) {
    console.log(`Drawer ${leavingPlayerName} left during their turn`);
    
    // Send a system message about drawer leaving
    const drawerLeftMessage = {
      id: `system-${Date.now()}`,
      playerId: 'system',
      username: 'System',
      message: `${leavingPlayerName} left while drawing`,
      isSystemMessage: true,
      type: 'leave-drawing',
      timestamp: Date.now()
    };
    
    if (room.chatHistory) {
      room.chatHistory.push(drawerLeftMessage);
      
      if (room.chatHistory.length > 100) {
        room.chatHistory.shift();
      }
    }
    
    // Notify all players that drawer left
    io.to(roomId).emit('chatMessage', drawerLeftMessage);
    
    // Clear any active timers - with additional safeguard
    if (room && room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
    
    // If game was in progress, move to next player
    if (room.status === 'playing' || room.status === 'selecting') {
      setTimeout(() => {
        // Start next round with new drawer
        startRound(roomId);
      }, 2000);
    }
  } else {
    // Regular player left message
    const leaveMessage = {
      id: `system-${Date.now()}`,
      username: 'System',
      message: `${leavingPlayerName} left the room`,
      type: 'system',
      timestamp: Date.now()
    };
    
    if (room.chatHistory) {
      room.chatHistory.push(leaveMessage);
      
      if (room.chatHistory.length > 100) {
        room.chatHistory.shift();
      }
    }
    
    io.to(roomId).emit('chatMessage', leaveMessage);
  }
  
  // Broadcast updated player list
  io.to(roomId).emit('playerLeft', {
    players: room.players,
    player: leavingPlayer
  });
  
  updatePublicRoomsList();
}

// Handle initial connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('identifyUser', (data) => {
    const { username, clientId, avatar } = data;
    
    if (username) {
      // Simple defense against malicious usernames
      const sanitizedUsername = username.substring(0, 20).trim();
      
      console.log(`Client connected - ID: ${clientId}, Username: ${sanitizedUsername}`);
      
      // If clientId is provided, associate it with this socket
      if (clientId) {
        usersByClientId.set(clientId, {
          socketId: socket.id,
          username: sanitizedUsername,
          avatar: avatar || 0
        });
      }
      
      // Check if user was in a room previously
      const existingRoomId = findRoomByClientId(clientId);
      if (existingRoomId) {
        const room = rooms.get(existingRoomId);
        if (room) {
          socket.emit('rejoinPrompt', { roomId: existingRoomId, username: sanitizedUsername });
        }
      }
    }
  });
  
  // Handler for creating a room
  socket.on('createRoom', (data) => {
    try {
      const { username, avatar = 0, clientId, isPrivate, isPublic } = data;
      
      console.log(`Creating room request from ${username} (${socket.id}), isPublic: ${isPublic}`);
      
      if (!username) {
        return socket.emit('errorMessage', 'Username required');
      }
      
      const sanitizedUsername = username.substring(0, 20).trim();
      
      // Associate clientId with socket if provided
      if (clientId) {
        usersByClientId.set(clientId, {
          socketId: socket.id,
          username: sanitizedUsername,
          avatar: avatar || 0
        });
      }
      
      // For backwards compatibility, check both isPublic and !isPrivate
      const isRoomPublic = isPublic === true || (isPrivate === false);
      
      // Create new room
      const roomState = createRoomState(isRoomPublic, socket.id, sanitizedUsername, avatar);
      const roomId = roomState.id;
      
      // Join the socket to the room
      console.log(`Explicitly joining socket ${socket.id} to room ${roomId}`);
      socket.join(roomId);
      
      // Emit events
      socket.emit('roomCreated', { roomId });
      socket.emit('joinedRoom', { 
        roomId, 
        players: roomState.players
      });
      
      console.log(`Room created: ${roomId}, Public: ${isRoomPublic}, Host: ${sanitizedUsername}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('errorMessage', 'Failed to create room');
    }
  });
  
  // Handler for joining a room
  socket.on('joinRoom', (data) => {
    try {
      const { roomId, username, avatar = 0, clientId } = data;
      
      if (!username) {
        return socket.emit('errorMessage', 'Username required');
      }
      
      if (!roomId) {
        return socket.emit('errorMessage', 'Room ID required');
      }
      
      const sanitizedUsername = username.substring(0, 20).trim();
      const room = rooms.get(roomId);
      
      if (!room) {
        return socket.emit('errorMessage', 'Room not found');
      }
      
      // Check if room is full
      if (room.players.length >= (room.maxPlayers || 8)) {
        return socket.emit('errorMessage', 'Room is full');
      }
      
      // Create new player
      const player = {
        id: socket.id,
        username: sanitizedUsername,
        score: 0,
        avatar: avatar || 0,
        isHost: false,
        isDrawing: false,
        hasGuessedCorrectly: false,
        isConnected: true
      };
      
      // Associate clientId with socket if provided
      if (clientId) {
        usersByClientId.set(clientId, {
          socketId: socket.id,
          username: sanitizedUsername,
          avatar: avatar || 0
        });
      }
      
      // Add player to room
      room.players.push(player);
      
      // Join the socket to the room
      socket.join(roomId);
      
      // Send the current game state to the player
      let joinData = {
        roomId,
        players: room.players
      };
      
      // If game is in progress, send additional data
      if (room.status !== 'waiting') {
        const isDrawing = false; // New players can't be drawing
        const currentWord = isDrawing ? room.word : ''; // Only send word to drawer
        
        // Add a welcome message to the chat
        const joinMessage = {
          id: `system-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          username: 'System',
          message: `${sanitizedUsername} joined the room`,
          timestamp: Date.now(),
          type: 'system'
        };
        
        room.chatHistory.push(joinMessage);
        
        // Send game state for in-progress game
        joinData = {
          ...joinData,
          gameState: {
            status: room.status,
            round: room.round,
            totalRounds: room.totalRounds,
            timeLeft: room.timeLeft,
            drawer: room.currentDrawer?.id || '',
            drawerName: room.currentDrawer?.username || '',
            isDrawing: isDrawing
          },
          word: currentWord,
          round: room.round,
          totalRounds: room.totalRounds,
          currentDrawer: room.currentDrawer?.id || '',
          timeLeft: room.timeLeft,
          chatMessages: room.chatHistory
        };
        
        socket.emit('rejoinedRoom', joinData);
      } else {
        socket.emit('joinedRoom', joinData);
      }
      
      // Notify other players
      socket.to(roomId).emit('playerJoined', { 
        players: room.players,
        player: player
      });
      
      // Add system message to chat for all users
      io.to(roomId).emit('chatMessage', {
        id: `system-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        username: 'System',
        message: `${sanitizedUsername} joined the room`,
        timestamp: Date.now(),
        type: 'system'
      });
      
      console.log(`Player ${sanitizedUsername} joined room ${roomId}`);
      
      // Update public room info if room is public
      if (room.isPublic) {
        updatePublicRoomInfo(roomId);
      }
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('errorMessage', 'Failed to join room');
    }
  });
  
  // Handler for starting game
  socket.on('startGame', (settings) => {
    try {
      // Get room ID using helper function
      const roomId = findUserRoom(socket.id);
      
      if (!roomId) {
        return socket.emit('errorMessage', 'User not found in any room');
      }
      
      const room = rooms.get(roomId);
      
      if (!room) {
        return socket.emit('errorMessage', 'Room not found');
      }
      
      if (room.players.length < 2) {
        return socket.emit('errorMessage', 'At least 2 players required to start');
      }
      
      // Check if user is host
      const player = room.players.find(p => p.id === socket.id);
      if (!player || !player.isHost) {
        return socket.emit('errorMessage', 'Only host can start the game');
      }
      
      // Update room settings
      room.drawTime = settings.drawTime || 80;
      room.totalRounds = settings.rounds || 3;
      room.maxPlayers = settings.maxPlayers || 8;
      room.gameMode = settings.gameMode || 'Normal';
      room.hintsInterval = settings.hintsInterval || 2;
      
      if (room.gameMode === 'Custom Words' && settings.customWords) {
        room.customWords = settings.customWords.split(',')
          .map(word => word.trim())
          .filter(word => word.length > 0 && word.length <= 30);
      }
      
      // Start game with round 1
      room.round = 1;
      room.status = 'playing';
      
      // Select first drawer (start with the host)
      const firstDrawer = room.players.find(p => p.isHost);
      if (firstDrawer) {
        firstDrawer.isDrawing = true;
        room.currentDrawer = firstDrawer;
      }
      
      // Let clients know game is starting
      io.to(roomId).emit('gameStarted', {
        round: room.round,
        totalRounds: room.totalRounds,
        drawer: {
          id: room.currentDrawer.id,
          username: room.currentDrawer.username
        }
      });
      
      // Give word options to the first drawer
      const wordOptions = room.gameMode === 'Custom Words' && room.customWords.length >= 3
        ? room.customWords.sort(() => 0.5 - Math.random()).slice(0, 3)
        : getRandomWords(3);
      
      room.wordOptions = wordOptions;
      io.to(room.currentDrawer.id).emit('wordSelection', { words: wordOptions });
      
      // Set initial timeout for word selection
      room.timeLeft = 15; // 15 seconds to select a word
      room.status = 'selecting';
      
      // Update public room info to show game is in progress
      if (room.isPublic) {
        updatePublicRoomInfo(roomId);
      }
      
      // Start timer for word selection
      startGameTimer(roomId);
      
      console.log(`Game started in room ${roomId}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('errorMessage', 'Failed to start game');
    }
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
          const player = room.players[playerIndex];
          const playerName = player.username;
          room.players[playerIndex].isConnected = false;
          
          // Store disconnect timestamp
          room.players[playerIndex].disconnectedAt = Date.now();
          
          // Update the client ID map
          const clientId = Object.keys(usersByClientId).find(id => 
            usersByClientId.get(id).socketId === socket.id
          );
          
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
          
          // Check if the disconnected player was drawing
          const wasDrawing = room.currentDrawer && room.currentDrawer.id === socket.id && 
                            (room.status === 'playing' || room.status === 'selecting');
          
          if (wasDrawing) {
            // Immediately handle drawer disconnection for better gameplay experience
            console.log(`Drawer ${playerName} disconnected during their turn`);
            
            // Send a clear notification message about drawer leaving
            const drawerLeftMessage = {
              id: `system-${Date.now()}`,
              playerId: 'system',
              username: 'System',
              message: `${playerName} left while drawing`,
              isSystemMessage: true,
              type: 'leave-drawing',
              timestamp: Date.now()
            };
            
            if (room.chatHistory) {
              room.chatHistory.push(drawerLeftMessage);
              
              if (room.chatHistory.length > 100) {
                room.chatHistory.shift();
              }
            }
            
            // Notify all players that drawer left
            io.to(roomId).emit('chatMessage', drawerLeftMessage);
            io.to(roomId).emit('drawerLeft', { drawerName: playerName });
            
            // Clear any active timers
            if (room.timer) {
              clearInterval(room.timer);
              room.timer = null;
            }
            
            // Handle drawer leaving immediately
            handlePlayerLeave(socket, roomId);
            
            // After a small delay, move to next player
            setTimeout(() => {
              if (rooms.has(roomId)) {
                startRound(roomId);
              }
            }, 2000);
          } else {
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
    }
  });

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
      
      if (!room.currentDrawer || room.currentDrawer.id !== socket.id || room.status !== 'selecting') {
        console.error(`User ${socket.id} is not the current drawer or room is not in selecting state`);
        return;
      }
      
      handleWordSelection(room, word);
      
      console.log(`Word selected in room ${roomId}: ${word}`);
    } catch (error) {
      console.error('Error selecting word:', error);
    }
  });
  
  socket.on('chatMessage', ({ message, options }) => {
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
        
        // Check if the guess is correct - make it more strict for long words
        const isExactMatch = normalizedGuess === normalizedWord;
        const isCloseEnough = normalizedGuess.length > 6 && 
                            normalizedWord.length > 6 && 
                            levenshteinDistance(normalizedGuess, normalizedWord) === 1;
        
        // Check for a "close" guess from the client
        const isCloseGuess = options && options.isCloseGuess === true;
                           
        if (isExactMatch || isCloseEnough) {
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
            type: 'correct',
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
          
          // Send the full word to the player who guessed correctly
          io.to(socket.id).emit('wordGuessed', {
            word: room.word
          });
          
          // Explicitly update the word hint for this player
          io.to(socket.id).emit('wordHint', {
            hint: room.word,
            hintNumber: 3, // Using 3 to indicate full word revealed
            fullWord: true
          });
          
          // Check if all non-drawers have guessed the word
          const allNonDrawersGuessed = room.players.filter(p => !p.disconnected).every(p => 
            p.id === room.currentDrawer.id || p.hasGuessedCorrectly || p.disconnected);
          
          if (allNonDrawersGuessed) {
            clearInterval(room.timer);
            
            setTimeout(() => {
              endRound(roomId);
            }, 1500);
          }
        } else if (isCloseGuess) {
          // The guess is close but not exact - create a "close" message
          const closeGuessMessage = {
            id: uuidv4(),
            playerId: 'system',
            username: 'System',
            message: `${player.username} is close!`,
            isSystemMessage: true,
            type: 'close',
            timestamp: Date.now()
          };
          
          room.chatHistory.push(closeGuessMessage);
          
          if (room.chatHistory.length > 100) {
            room.chatHistory.shift();
          }
          
          // Send this message to everyone
          io.to(roomId).emit('chatMessage', closeGuessMessage);
          
          // Also send the regular message
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
          
          // Send normal message to all players
          io.to(roomId).emit('chatMessage', chatMessage);
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
      
      if (!room.currentDrawer || room.currentDrawer.id !== socket.id || room.status !== 'playing') {
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
      
      if (!room.currentDrawer || room.currentDrawer.id !== socket.id || room.status !== 'playing') {
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
      // Store timer reference before deletion
      const roomTimer = room.timer;
      
      console.log(`Deleting inactive room: ${roomId}`);
      rooms.delete(roomId);
      
      // Clear timer after deletion
      if (roomTimer) {
        clearInterval(roomTimer);
      }
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