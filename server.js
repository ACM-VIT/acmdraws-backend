const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

// Helper function to generate a unique room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Helper function to generate a unique message ID
function generateId() {
  return uuidv4();
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  path: '/skribbl',
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 30000,
  maxHttpBufferSize: 5e6,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 32768
  }
});

// Initialize data structures
const rooms = new Map();
const publicRooms = new Map();
const users = new Map();
const disconnectedUsers = new Map();

const words = [
  'apple', 'banana', 'orange', 'strawberry', 'grape',
  'car', 'bus', 'train', 'airplane', 'bicycle',
  'dog', 'cat', 'elephant', 'tiger', 'lion',
  'house', 'building', 'castle', 'apartment', 'hotel',
  'tree', 'flower', 'mountain', 'river', 'ocean',
  'computer', 'phone', 'tablet', 'keyboard', 'mouse',
  'book', 'newspaper', 'magazine', 'letter', 'envelope',
  'chair', 'table', 'sofa', 'bed', 'lamp',
  'shirt', 'pants', 'dress', 'shoes', 'hat',
  'pizza', 'burger', 'pasta', 'sandwich', 'cake'
];

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
    maxPlayers: room.maxPlayers,
    inProgress: room.status !== 'waiting'
  });
}

function removePublicRoom(roomId) {
  publicRooms.delete(roomId);
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
  
  room.players.forEach(player => {
    if (player.id === room.currentDrawer) {
      io.to(player.id).emit('roundStarted', {
        gameState: 'playing',
        drawer: room.currentDrawer,
        drawerName: drawerPlayer.username,
        word: selectedWord,
        timeLeft: room.timeLeft,
        isDrawing: true
      });
    } else {
      io.to(player.id).emit('roundStarted', {
        gameState: 'playing',
        drawer: room.currentDrawer,
        drawerName: drawerPlayer.username,
        timeLeft: room.timeLeft,
        word: hiddenWord
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

// Room cleanup interval (2 minutes)
const ROOM_CLEANUP_INTERVAL = 2 * 60 * 1000;

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.conn.on('packet', (packet) => {
    if (packet.type === 'ping' || packet.type === 'pong') return;
    console.log(`Socket ${socket.id} received packet: ${packet.type}`);
  });
  
  socket.conn.on('upgrade', (transport) => {
    console.log(`Socket ${socket.id} transport upgraded to: ${transport.name}`);
  });
  
  socket.conn.on('error', (err) => {
    console.error(`Socket ${socket.id} connection error:`, err);
  });
  
  socket.on('createRoom', ({ isPublic, username, avatar }) => {
    try {
      if (!username) {
        throw new Error('Username is required');
      }

      // Generate a unique room ID
      const roomId = generateRoomId();
      
      // Create a new room
      const room = {
        id: roomId,
        isPublic,
        players: [],
        status: 'waiting',
        currentDrawer: null,
        word: '',
        wordOptions: [],
        timeLeft: 0,
        round: 1,
        totalRounds: 3,
        drawHistory: [],
        currentHint: '',
        hintNumber: 0,
        isGameOver: false,
        winners: [],
        timer: null
      };

      // Add the creator as the first player and host
      const player = {
        id: socket.id,
        username: username,
        score: 0,
        isHost: true,
        isDrawing: false,
        hasGuessedCorrectly: false,
        avatar: avatar || Math.floor(Math.random() * 10),
        disconnected: false,
        hasBeenDrawer: false
      };

      room.players.push(player);
      
      // Store the room in the rooms Map
      rooms.set(roomId, room);
      
      // Store the room ID and username in the socket for later use
      socket.roomId = roomId;
      socket.username = username;
      
      // Store user info
      users.set(socket.id, {
        username,
        roomId,
        avatar
      });
      
      // Join the socket to the room
      socket.join(roomId);
      
      // Send room created confirmation
      socket.emit('roomCreated', { 
        roomId,
        isPublic 
      });

      // Broadcast initial game state
      io.to(roomId).emit('gameState', {
        state: 'waiting',
        players: room.players,
        currentDrawer: null,
        word: '',
        wordOptions: [],
        timeLeft: 0,
        round: 1,
        totalRounds: 3,
        currentHint: '',
        hintNumber: 0,
        isGameOver: false,
        winners: []
      });

      // Update public rooms if necessary
      if (isPublic) {
        updatePublicRoomInfo(roomId);
      }

      console.log(`Room created: ${roomId}, Public: ${isPublic}, Host: ${username}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', { message: error.message || 'Failed to create room' });
    }
  });
  
  socket.on('joinRoom', ({ roomId, username, avatar }) => {
    try {
      if (!username) {
        throw new Error('Username is required');
      }

      const room = rooms.get(roomId);
      if (!room) {
        throw new Error('Room not found or expired');
      }

      // Check if the room is full (excluding disconnected players)
      const activePlayers = room.players.filter(p => !p.disconnected);
      if (activePlayers.length >= 12) {
        throw new Error('Room is full');
      }

      const existingPlayer = room.players.find(p => 
        p.username === username && !p.disconnected
      );

      // if (existingPlayer) {
      //   throw new Error('Username is already taken');
      // }

      // Check if this player was previously in the room but disconnected
      const disconnectedPlayerIndex = room.players.findIndex(p => 
        p.username === username && p.disconnected
      );

      if (disconnectedPlayerIndex !== -1) {
        // Reconnect the player
        const player = room.players[disconnectedPlayerIndex];
        player.id = socket.id;
        player.disconnected = false;
        player.avatar = avatar || player.avatar;

        // Store user info
        users.set(socket.id, {
          username,
          roomId,
          avatar: player.avatar
        });

        // Join the socket to the room
        socket.join(roomId);

        // If this was the drawer before disconnecting, restore their status
        if (room.currentDrawerName === username) {
          room.currentDrawer = socket.id;
        }

        // Send reconnection message
        io.to(roomId).emit('chatMessage', {
          id: generateId(),
          username: 'System',
          message: `${username} reconnected`,
          isSystemMessage: true
        });

        console.log(`Player ${username} reconnected to room: ${roomId}`);
      } else {
        // Add as a new player
        const player = {
          id: socket.id,
          username: username,
          score: 0,
          isHost: false,
          isDrawing: false,
          hasGuessedCorrectly: false,
          avatar: avatar || Math.floor(Math.random() * 10),
          disconnected: false,
          hasBeenDrawer: false
        };

        room.players.push(player);

        // Store user info
        users.set(socket.id, {
          username,
          roomId,
          avatar: player.avatar
        });

        // Join the socket to the room
        socket.join(roomId);

        // Send welcome message
        io.to(roomId).emit('chatMessage', {
          id: generateId(),
          username: 'System',
          message: `${username} joined the room`,
          isSystemMessage: true
        });

        console.log(`Player ${username} joined room: ${roomId}`);
      }

      // Update public rooms if necessary
      if (room.isPublic) {
        updatePublicRoomInfo(roomId);
      }

      // Broadcast updated game state
      io.to(roomId).emit('gameState', {
        state: room.status,
        players: room.players,
        currentDrawer: room.currentDrawer,
        word: room.word,
        wordOptions: room.wordOptions,
        timeLeft: room.timeLeft,
        round: room.round,
        totalRounds: room.totalRounds,
        currentHint: room.currentHint,
        hintNumber: room.hintNumber,
        isGameOver: room.isGameOver,
        winners: room.winners
      });

    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: error.message || 'Failed to join room' });
    }
  });
  
  socket.on('getPublicRooms', () => {
    socket.emit('publicRooms', getPublicRoomsInfo());
  });
  
  socket.on('startGame', (settings) => {
    try {
      const user = users.get(socket.id);
      if (!user) {
        console.error('No user found for socket ID:', socket.id);
        return;
      }
      
      const room = rooms.get(user.roomId);
      if (!room) {
        console.error('No room found with ID:', user.roomId);
        return;
      }
      
      const playerObj = room.players.find(p => p.id === socket.id);
      console.log(`Start game request from ${user.username} (${socket.id})`);
      console.log(`Player object:`, playerObj);
      console.log(`Room hostId: ${room.hostId}, Room players:`, room.players);
      
      if (!playerObj || !playerObj.isHost) {
        console.error(`User ${user.username} (${socket.id}) is not the host`);
        socket.emit('errorMessage', 'Only the host can start the game');
        return;
      }
      
      if (room.players.length < 2) {
        socket.emit('errorMessage', 'Need at least 2 players to start');
        return;
      }
      
      console.log(`Starting game in room ${user.roomId} with settings:`, settings);
      
      room.totalRounds = settings.rounds || 3;
      room.drawTime = settings.drawTime || 80;
      room.maxPlayers = settings.maxPlayers || 8;
      room.gameMode = settings.gameMode || 'Normal';
      room.hintsInterval = settings.hintsInterval || 2;
      
      if (settings.customWords && room.gameMode === 'Custom Words') {
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
      
      updatePublicRoomInfo(user.roomId);
      
      startRound(user.roomId);
      
      console.log(`Game started in room: ${user.roomId}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('errorMessage', 'Failed to start game');
    }
  });
  
  socket.on('selectWord', ({ word }) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;
      
      const room = rooms.get(user.roomId);
      if (!room) return;
      
      if (room.currentDrawer !== socket.id || room.status !== 'selecting') {
        return;
      }
      
      handleWordSelection(room, word);
      
      console.log(`Word selected in room ${user.roomId}: ${word}`);
    } catch (error) {
      console.error('Error selecting word:', error);
    }
  });
  
  socket.on('chatMessage', ({ message }) => {
    try {
      const user = users.get(socket.id);
      if (!user) return;
      
      const room = rooms.get(user.roomId);
      if (!room) return;
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      
      if (!room.chatHistory) {
        room.chatHistory = [];
      }
      
      // If the player is drawing, they can send normal messages to everyone
      if (player.isDrawing) {
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: user.username,
          message,
          timestamp: Date.now()
        };
        
        room.chatHistory.push(chatMessage);
        
        if (room.chatHistory.length > 100) {
          room.chatHistory.shift();
        }
        
        io.to(user.roomId).emit('chatMessage', chatMessage);
        return;
      }
      
      // If player already guessed correctly, their messages are only seen by other correct guessers and the drawer
      if (player.hasGuessedCorrectly) {
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: user.username,
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
            message: `${user.username} guessed the word!`,
            isSystemMessage: true,
            isCorrectGuess: true,
            timestamp: Date.now()
          };
          
          room.chatHistory.push(correctGuessMessage);
          
          if (room.chatHistory.length > 100) {
            room.chatHistory.shift();
          }
          
          io.to(user.roomId).emit('chatMessage', correctGuessMessage);
          
          io.to(user.roomId).emit('playerJoined', { 
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
              endRound(user.roomId);
            }, 1500);
          }
        } else {
          // The guess is incorrect - create a regular message
          const chatMessage = {
            id: uuidv4(),
            playerId: socket.id,
            username: user.username,
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
          username: user.username,
          message,
          timestamp: Date.now()
        };
        
        room.chatHistory.push(chatMessage);
        
        if (room.chatHistory.length > 100) {
          room.chatHistory.shift();
        }
        
        io.to(user.roomId).emit('chatMessage', chatMessage);
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });
  
  socket.on('drawing', (data) => {
    try {
      console.log(`Received drawing data from ${socket.id}`);
      
      const user = users.get(socket.id);
      if (!user) {
        console.error('Unknown user trying to draw');
        return;
      }
      
      const room = rooms.get(user.roomId);
      if (!room) {
        console.error('Unknown room for drawing');
        return;
      }
      
      if (room.currentDrawer !== socket.id) {
        console.error(`User ${socket.id} is not the current drawer`);
        return;
      }
      
      // Store drawing history for future players who join
      if (data.line) {
        room.drawingHistory.push(data);
      }
      
      // Broadcast drawing data to all other players in the room
      socket.to(user.roomId).emit('drawingData', data);
    } catch (error) {
      console.error('Error handling drawing data:', error);
    }
  });
  
  socket.on('clearCanvas', () => {
    try {
      const user = users.get(socket.id);
      if (!user) return;
      
      const room = rooms.get(user.roomId);
      if (!room) return;
      
      if (room.currentDrawer !== socket.id || room.status !== 'playing') {
        return;
      }
      
      socket.to(user.roomId).emit('canvasCleared');
    } catch (error) {
      console.error('Error handling clear canvas:', error);
    }
  });
  
  socket.on('disconnect', () => {
    try {
      const user = users.get(socket.id);
      if (!user || !user.roomId) return;

      const room = rooms.get(user.roomId);
      if (!room) return;

      console.log(`User disconnected: ${socket.id} from room: ${user.roomId}`);

      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        // Mark the player as disconnected
        room.players[playerIndex].disconnected = true;

        // If the disconnected player was the drawer, end the round
        if (room.currentDrawer === socket.id && room.status === 'playing') {
          endRound(user.roomId);
        }

        // If all players are disconnected, schedule room for cleanup
        const connectedPlayers = room.players.filter(p => !p.disconnected);
        if (connectedPlayers.length === 0) {
          console.log(`Scheduling cleanup for empty room: ${user.roomId}`);
          setTimeout(() => {
            const room = rooms.get(user.roomId);
            if (room && room.players.every(p => p.disconnected)) {
              console.log(`Cleaning up empty room: ${user.roomId}`);
              if (room.timer) {
                clearInterval(room.timer);
              }
              rooms.delete(user.roomId);
              if (room.isPublic) {
                publicRooms.delete(user.roomId);
              }
            }
          }, ROOM_CLEANUP_INTERVAL);
        }

        // If the host disconnected, assign a new host
        if (room.players[playerIndex].isHost) {
          const newHost = room.players.find(p => !p.disconnected);
          if (newHost) {
            newHost.isHost = true;
          }
        }

        // Broadcast updated game state
        io.to(user.roomId).emit('gameState', {
          state: room.status,
          players: room.players,
          currentDrawer: room.currentDrawer,
          word: room.word,
          wordOptions: room.wordOptions,
          timeLeft: room.timeLeft,
          round: room.round,
          totalRounds: room.totalRounds,
          currentHint: room.currentHint,
          hintNumber: room.hintNumber,
          isGameOver: room.isGameOver,
          winners: room.winners
        });

        // Store disconnect info for potential reconnection
        disconnectedUsers.set(socket.handshake.address, {
          username: user.username,
          roomId: user.roomId,
          avatar: user.avatar,
          timestamp: Date.now()
        });
      }

      users.delete(socket.id);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
  
  socket.on('leaveRoom', () => {
    try {
      const user = users.get(socket.id);
      if (!user) return;
      
      const room = rooms.get(user.roomId);
      if (!room) return;
      
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const isHost = room.players[playerIndex].isHost;
        const isDrawer = room.players[playerIndex].id === room.currentDrawer;
        
        room.players.splice(playerIndex, 1);
        
        socket.leave(user.roomId);
        
        if (room.players.length === 0) {
          clearInterval(room.timer);
          rooms.delete(user.roomId);
          
          if (room.isPublic) {
            removePublicRoom(user.roomId);
          }
          
          console.log(`Room deleted: ${user.roomId}`);
        } else {
          if (isHost) {
            room.players[0].isHost = true;
            room.hostId = room.players[0].id;
          }
          
          updatePublicRoomInfo(user.roomId);
          
          io.to(user.roomId).emit('playerLeft', {
            players: room.players
          });
          
          io.to(user.roomId).emit('chatMessage', {
            id: uuidv4(),
            playerId: 'system',
            username: 'System',
            message: `${user.username} left the room`,
            isSystemMessage: true,
            timestamp: Date.now()
          });
          
          if (isDrawer && room.status !== 'waiting') {
            clearInterval(room.timer);
            
            setTimeout(() => {
              startRound(user.roomId);
            }, 2000);
          }
        }
      }
      
      users.set(socket.id, {
        username: user.username,
        avatar: user.avatar
      });
    } catch (error) {
      console.error('Error handling leave room:', error);
    }
  });

  socket.on('rejoinRoom', ({ roomId, username, avatar }) => {
    try {
      if (!rooms.has(roomId)) {
        socket.emit('errorMessage', 'Room not found or expired');
        return;
      }
      
      const room = rooms.get(roomId);
      
      // First try to find if this player was in the room before but disconnected
      // We'll check by username since the socket ID would be different after reconnect
      const existingPlayerIndex = room.players.findIndex(p => p.username === username);
      
      if (existingPlayerIndex !== -1) {
        // Update the existing player's socket ID and clear disconnected flag
        room.players[existingPlayerIndex].id = socket.id;
        room.players[existingPlayerIndex].disconnected = false;
        
        // If this player was the drawer before, update the currentDrawer reference
        if (room.currentDrawerName === username) {
          room.currentDrawer = socket.id;
        }
        
        users.set(socket.id, {
          username,
          roomId,
          avatar,
          address: socket.handshake.address
        });
        
        socket.join(roomId);
        
        // Update all clients with the reconnected player
        io.to(roomId).emit('playerJoined', {
          players: room.players
        });
        
        io.to(roomId).emit('chatMessage', {
          id: uuidv4(),
          playerId: 'system',
          username: 'System',
          message: `${username} reconnected`,
          isSystemMessage: true,
          timestamp: Date.now()
        });
        
        // Send game state to the reconnected player
        socket.emit('rejoinedRoom', {
          roomId,
          players: room.players,
          gameState: room.status,
          round: room.round,
          totalRounds: room.totalRounds,
          currentDrawer: room.currentDrawer,
          timeLeft: room.timeLeft,
          chatMessages: room.chatHistory || [],
          word: room.currentDrawer === socket.id ? room.word : undefined
        });
        
        // Clear the canvas and then send drawing history
        socket.emit('canvasCleared');
        
        if (room.drawingHistory && room.drawingHistory.length > 0) {
          socket.emit('drawingBatch', room.drawingHistory);
        }
        
        // If this player had guessed the word before, tell them the word again
        if (room.players[existingPlayerIndex].hasGuessedCorrectly) {
          socket.emit('wordGuessed', {
            word: room.word
          });
        }
        
        console.log(`${username} rejoined room: ${roomId}`);
      } else {
        // Player is new to this room, add them as a new player
        room.players.push({
          id: socket.id,
          username,
          score: 0,
          avatar,
          isHost: false,
          isDrawing: false,
          hasGuessedCorrectly: false
        });
        
        users.set(socket.id, { 
          username, 
          roomId,
          avatar
        });
        
        socket.join(roomId);
        
        updatePublicRoomInfo(roomId);
        
        io.to(roomId).emit('playerJoined', { 
          players: room.players
        });
        
        socket.emit('joinedRoom', { 
          roomId,
          players: room.players
        });
        
        io.to(roomId).emit('chatMessage', {
          id: uuidv4(),
          playerId: 'system',
          username: 'System',
          message: `${username} joined the room`,
          isSystemMessage: true,
          timestamp: Date.now()
        });
        
        console.log(`${username} joined room as new player: ${roomId}`);
      }
    } catch (error) {
      console.error('Error rejoining room:', error);
      socket.emit('errorMessage', 'Failed to rejoin room');
    }
  });
});

app.get('/', (req, res) => {
  res.send('why ru here');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = server; 