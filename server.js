const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('well what are you doing here?');
});

const SERVER_CONFIG = {
  MAINTENANCE_MODE: false,        // Set to true to put server in maintenance mode
  DISABLE_USERNAME_EDIT: true,   // Set to true to prevent players from changing default usernames
  FORCE_PRIVATE_ROOMS: false,     // Set to true to disable public rooms
  MAX_PLAYERS_PER_ROOM: 50,       // Maximum players allowed per room
  CUSTOM_WORDS_ENABLED: true,     // Set to false to disable custom words
  MAINTENANCE_MESSAGE: "The server is currently undergoing maintenance. Please try again later.",
  VERSION: "1.0.0"                // Current server version
};

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateId() {
  return uuidv4();
}

let words = [];
let usedWords = new Set();
try {
  const dictionaryPath = path.join(__dirname, 'public', 'dictionaryy.json');
  const dictionaryContent = fs.readFileSync(dictionaryPath, 'utf8');
  words = JSON.parse(dictionaryContent);
  console.log(`Loaded ${words.length} words from dictionary.json`);
} catch (error) {
  console.error('Error loading dictionary.json:', error);
  words = [
    'stIng', 'Labubu', 'dingDing', 'bEnten', 'coffIn',
    'braiNrot', 'cricKet', 'alterNate', 'ryan', 'binary',
    'janice', 'scrunchie', 'wikipedia', 'kingfisher', 'aasasbeard',
    'mannu'
  ];
  console.log('Using fallback word list');
}

const server = http.createServer(app);

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

const usersByClientId = new Map();
const rooms = new Map();
const publicRooms = new Map();
const games = new Map();

function findUserRoom(userId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.players.some(p => p.id === userId)) {
      return roomId;
    }
  }
  return null;
}

function findRoomByClientId(clientId) {
  const user = usersByClientId.get(clientId);
  if (!user) return null;
  return findUserRoom(user.socketId);
}

function getRandomWords(count = 3) {
  // Filter out already used words
  const availableWords = words.filter(word => !usedWords.has(word));
  
  // If we've used all words, reset the used words tracking
  if (availableWords.length < count) {
    usedWords.clear();
    return getRandomWords(count);
  }
  
  // Get random words from available words
  const shuffled = [...availableWords].sort(() => 0.5 - Math.random());
  const selectedWords = shuffled.slice(0, count);
  
  // Add selected words to used words set
  selectedWords.forEach(word => usedWords.add(word));
  
  return selectedWords;
}

function createRoomState(isPublic = false, hostId, hostUsername, hostAvatar) {
  const roomId = generateRoomId();
  console.log(`Creating room state with hostId: ${hostId}, username: ${hostUsername}`);
  const roomState = {
    id: roomId,
    isPublic: isPublic,
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
  for (const player of room.players) {
    if (player.id === room.currentDrawer.id || player.hasGuessedCorrectly) {
      continue;
    }
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
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1,
          matrix[i][j-1] + 1,
          matrix[i-1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function startRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Reset all player states for the new turn
  room.players.forEach(player => {
    player.hasGuessedCorrectly = false;
    player.isDrawing = false;
  });

  // Initialize turn tracking if needed
  if (room.currentTurn === undefined) {
    room.currentTurn = 1;
  }

  const activePlayers = room.players.filter(player => player.isConnected);
  const totalTurnsInRound = activePlayers.length;

  // Check if we've completed all turns in the current round
  if (room.currentTurn > totalTurnsInRound) {
    // Start new round
    room.currentTurn = 1;
    room.players.forEach(player => {
      player.hasDrawnThisRound = false;
    });
    room.round++;
    room.lastDrawer = null; // Reset last drawer for new round

    if (room.round > room.totalRounds) {
      return endGame(roomId);
    }

    io.to(roomId).emit('roundInfo', {
      round: room.round,
      totalRounds: room.totalRounds
    });
  }

  // Get eligible drawers (connected players who haven't drawn this round and weren't the last drawer)
  const eligibleDrawers = room.players.filter(player => 
    !player.hasDrawnThisRound && 
    player.isConnected &&
    (!room.lastDrawer || player.id !== room.lastDrawer.id)
  );

  // Select next drawer
  let nextDrawer;
  if (eligibleDrawers.length > 0) {
    nextDrawer = eligibleDrawers[Math.floor(Math.random() * eligibleDrawers.length)];
  } else {
    // If no eligible drawers, reset for next round
    room.players.forEach(player => {
      player.hasDrawnThisRound = false;
    });
    room.currentTurn = 1;
    room.round++;
    room.lastDrawer = null;

    if (room.round > room.totalRounds) {
      return endGame(roomId);
    }

    // Get first eligible player for new round
    nextDrawer = room.players.find(p => 
      p.isConnected && 
      (!room.lastDrawer || p.id !== room.lastDrawer.id)
    );

    if (!nextDrawer && activePlayers.length > 0) {
      // Fallback if no eligible players found
      nextDrawer = activePlayers[0];
    }
  }

  if (!nextDrawer) {
    console.error(`No eligible drawer found in room ${roomId}`);
    return;
  }

  // Setup new drawer
  nextDrawer.isDrawing = true;
  nextDrawer.hasDrawnThisRound = true;
  room.currentDrawer = nextDrawer;
  room.lastDrawer = nextDrawer;
  
  // Emit state update to all players
  io.to(roomId).emit('turnState', {
    drawer: nextDrawer.id,
    players: room.players
  });

  console.log(`Player ${nextDrawer.username} is now drawing in room ${roomId} (Turn ${room.currentTurn} of ${totalTurnsInRound})`);

  // Clear canvas and start word selection
  io.to(roomId).emit('canvasCleared');
  io.to(roomId).emit('turnStarted', {
    players: room.players,
    drawer: nextDrawer,
    currentTurn: room.currentTurn,
    totalTurns: totalTurnsInRound
  });

  // Increment the turn counter after the current player has been set up
  room.currentTurn++;

  let wordOptions;
  if (room.gameMode === 'Custom Words' && room.customWords && room.customWords.length >= 3) {
    wordOptions = [...room.customWords].sort(() => 0.5 - Math.random()).slice(0, 3);
  } else {
    wordOptions = getRandomWords(3);
  }

  room.wordOptions = wordOptions;
  room.status = 'selecting';
  room.timeLeft = 15;

  io.to(nextDrawer.id).emit('wordSelection', { words: wordOptions });
  io.to(roomId).emit('gameStarted', {
    round: room.round,
    totalRounds: room.totalRounds,
    drawer: {
      id: nextDrawer.id,
      username: nextDrawer.username
    }
  });

  io.to(roomId).emit('playerSelecting', {
    drawer: nextDrawer.id,
    drawerName: nextDrawer.username
  });

  startGameTimer(roomId);

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
  io.to(room.id).emit('canvasCleared');
  room.drawingHistory = [];
  for (const player of room.players) {
    const isDrawer = player.id === room.currentDrawer.id;
    const wordToSend = isDrawer ? selectedWord : selectedWord.replace(/[a-zA-Z]/g, '_');
    io.to(player.id).emit('roundStart', {
      drawer: room.currentDrawer.id,
      drawerName: room.currentDrawer.username,
      word: wordToSend,
      timeLeft: room.timeLeft,
      isDrawing: isDrawer
    });
    if (!isDrawer) {
      io.to(player.id).emit('wordHint', { 
        hint: wordToSend,
        hintNumber: 0
      });
    }
  }
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

  // Reset all player states
  room.players.forEach(player => {
    player.hasGuessedCorrectly = false;
    player.isDrawing = false;  // Explicitly reset drawing state
  });
  room.currentDrawer = null;

  // Emit turn end with reset states
  io.to(roomId).emit('turnEnded', {
    word: room.word,
    players: room.players,
    currentTurn: room.currentTurn,
    totalTurns: room.players.filter(p => p.isConnected).length,
    status: 'waiting'
  });

  // Check if all players have drawn in this round
  const allPlayersHaveDrawn = room.players.every(player => {
    return player.hasDrawnThisRound === true || !player.isConnected;
  });

  setTimeout(() => {
    if (allPlayersHaveDrawn) {
      if (room.round >= room.totalRounds) {
        endGame(roomId);
      } else {
        // Reset all hasDrawnThisRound flags for the new round
        room.players.forEach(player => {
          player.hasDrawnThisRound = false;
          player.hasGuessedCorrectly = false; // Ensure this is reset for new round
        });
        room.round++;
        startRound(roomId);
      }
    } else {
      startRound(roomId);
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

const ROOM_CLEANUP_INTERVAL = 5 * 60 * 1000;

function handlePlayerLeave(socket, roomId, recursionDepth = 0) {
  // Prevent infinite recursion
  if (recursionDepth > 1) {
    console.warn(`Prevented recursive player leave handling for room ${roomId}`);
    return;
  }

  const room = rooms.get(roomId);
  if (!room) return;
  
  console.log(`Removing player ${socket.id} from room ${roomId}`);
  const wasDrawing = room.currentDrawer && room.currentDrawer.id === socket.id;
  const leavingPlayer = room.players.find(player => player.id === socket.id);
  const leavingPlayerName = leavingPlayer ? leavingPlayer.username : 'Player';

  // Update players list
  room.players = room.players.filter(player => player.id !== socket.id);

  // Handle empty room
  if (room.players.length === 0) {
    const roomTimer = room.timer;
    rooms.delete(roomId);
    if (roomTimer) {
      clearInterval(roomTimer);
    }
    console.log(`Room deleted: ${roomId}`);
    updatePublicRoomsList();
    return;
  }

  // Update host if needed
  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
    room.players[0].isHost = true;
  }

  // Handle drawer leaving
  if (wasDrawing) {
    console.log(`Drawer ${leavingPlayerName} left during their turn`);
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

    io.to(roomId).emit('chatMessage', drawerLeftMessage);
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    // Start new round after brief delay
    setTimeout(() => {
      if (rooms.has(roomId)) {
        startRound(roomId);
      }
    }, 2000);
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

  // Notify remaining players
  io.to(roomId).emit('playerLeft', {
    players: room.players,
    player: leavingPlayer
  });

  updatePublicRoomsList();
}

app.get('/api/config', (req, res) => {
  res.status(200).json(SERVER_CONFIG);
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Send server configuration to client immediately on connection
  socket.emit('serverConfig', SERVER_CONFIG);

  socket.on('identifyUser', (data) => {
    const { username, clientId, avatar } = data;
    if (username) {
      const sanitizedUsername = username.substring(0, 20).trim();
      console.log(`Client connected - ID: ${clientId}, Username: ${sanitizedUsername}`);
      if (clientId) {
        usersByClientId.set(clientId, {
          socketId: socket.id,
          username: sanitizedUsername,
          avatar: avatar || 0
        });
      }
      const existingRoomId = findRoomByClientId(clientId);
      if (existingRoomId) {
        const room = rooms.get(existingRoomId);
        if (room) {
          socket.emit('rejoinPrompt', { roomId: existingRoomId, username: sanitizedUsername });
        }
      }
    }

    // Check maintenance mode
    if (SERVER_CONFIG.MAINTENANCE_MODE) {
      socket.emit('maintenanceMode', { 
        message: SERVER_CONFIG.MAINTENANCE_MESSAGE 
      });
      return;
    }

    // Check username edit restrictions
    if (SERVER_CONFIG.DISABLE_USERNAME_EDIT && data.username && data.username.startsWith('Player')) {
      socket.emit('usernameRestricted', { 
        message: "Changing the default username is currently disabled." 
      });
    }
  });
  socket.on('createRoom', (data) => {
    try {
      const { username, avatar = 0, clientId, isPrivate, isPublic } = data;
      console.log(`Creating room request from ${username} (${socket.id}), isPublic: ${isPublic}`);
      if (!username) {
        return socket.emit('errorMessage', 'Username required');
      }
      const sanitizedUsername = username.substring(0, 20).trim();
      if (clientId) {
        usersByClientId.set(clientId, {
          socketId: socket.id,
          username: sanitizedUsername,
          avatar: avatar || 0
        });
      }

      // Check maintenance mode
      if (SERVER_CONFIG.MAINTENANCE_MODE) {
        socket.emit('maintenanceMode', { 
          message: SERVER_CONFIG.MAINTENANCE_MESSAGE 
        });
        return;
      }

      // Enforce private rooms if flag is enabled
      const isRoomPublic = SERVER_CONFIG.FORCE_PRIVATE_ROOMS ? false : (isPublic === true || (isPrivate === false));
      const roomState = createRoomState(isRoomPublic, socket.id, sanitizedUsername, avatar);
      const roomId = roomState.id;
      console.log(`Explicitly joining socket ${socket.id} to room ${roomId}`);
      socket.join(roomId);
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
  socket.on('joinRoom', (data) => {
    console.log('Join room request received:', data);
    const { roomId, username, avatar, clientId } = data;

    if (!roomId || !username) {
      socket.emit('errorMessage', 'Invalid room join request');
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('errorMessage', 'Room not found');
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('errorMessage', 'Room is full');
      return;
    }

    if (room.gameInProgress && !room.players.some(p => p.clientId === clientId)) {
      socket.emit('errorMessage', 'Game is in progress');
      return;
    }

    // If player is already in the room, update their socket
    const existingPlayer = room.players.find(p => p.clientId === clientId);
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.isConnected = true;
      socket.join(roomId);
      socket.emit('rejoinedRoom', {
        roomId,
        players: room.players,
        gameState: room.gameState,
        word: existingPlayer.isDrawing ? room.currentWord : undefined,
        round: room.round,
        totalRounds: room.totalRounds,
        currentDrawer: room.currentDrawer?.id,
        timeLeft: room.timeLeft,
        chatMessages: room.chatHistory
      });
      io.to(roomId).emit('playerStatus', { players: room.players });
      return;
    }

    const player = {
      id: socket.id,
      username,
      clientId,
      avatar: avatar || 0,
      score: 0,
      isHost: room.players.length === 0,
      isDrawing: false,
      hasGuessedCorrectly: false,
      isConnected: true
    };

    room.players.push(player);
    socket.join(roomId);

    console.log(`Player ${username} joined room ${roomId}`);
    socket.emit('joinedRoom', { roomId, players: room.players });
    io.to(roomId).emit('playerJoined', { players: room.players, player });

    if (room.isPublic) {
      updatePublicRoomInfo(roomId);
    }
  });
  socket.on('startGame', (settings) => {
    try {
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
      const player = room.players.find(p => p.id === socket.id);
      if (!player || !player.isHost) {
        return socket.emit('errorMessage', 'Only host can start the game');
      }

      // Set game settings
      room.drawTime = settings.drawTime || 80;
      room.totalRounds = settings.rounds || 3;

      // Apply server-side restrictions to game settings
      const maxAllowedPlayers = Math.min(settings.maxPlayers || 8, SERVER_CONFIG.MAX_PLAYERS_PER_ROOM);
      room.maxPlayers = maxAllowedPlayers;

      room.gameMode = settings.gameMode || 'Normal';
      room.hintsInterval = settings.hintsInterval || 2;

      // Respect custom words flag
      if (!SERVER_CONFIG.CUSTOM_WORDS_ENABLED) {
        room.gameMode = 'Normal';
        room.customWords = [];
      } else if (room.gameMode === 'Custom Words' && settings.customWords) {
        room.customWords = settings.customWords.split(',')
          .map(word => word.trim())
          .filter(word => word.length > 0 && word.length <= 30);
      }

      room.round = 1;
      room.status = 'playing';

      // Instead of making the host the first drawer, pick a random player
      const eligiblePlayers = room.players.filter(p => p.isConnected);
      const randomDrawer = eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];
      randomDrawer.isDrawing = true;
      randomDrawer.hasDrawnThisRound = true;
      room.currentDrawer = randomDrawer;

      io.to(roomId).emit('gameStarted', {
        round: room.round,
        totalRounds: room.totalRounds,
        drawer: {
          id: room.currentDrawer.id,
          username: room.currentDrawer.username
        }
      });

      const wordOptions = room.gameMode === 'Custom Words' && room.customWords.length >= 3
        ? room.customWords.sort(() => 0.5 - Math.random()).slice(0, 3)
        : getRandomWords(3);
      room.wordOptions = wordOptions;
      io.to(room.currentDrawer.id).emit('wordSelection', { words: wordOptions });
      room.timeLeft = 15;
      room.status = 'selecting';
      if (room.isPublic) {
        updatePublicRoomInfo(roomId);
      }
      startGameTimer(roomId);
      console.log(`Game started in room ${roomId} with drawer ${randomDrawer.username}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('errorMessage', 'Failed to start game');
    }
  });
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected - Socket: ${socket.id}, Reason: ${reason}`);
    const roomId = findUserRoom(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        console.log(`User disconnected: ${socket.id} from room: ${roomId}`);
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          const player = room.players[playerIndex];
          const playerName = player.username;
          room.players[playerIndex].isConnected = false;
          room.players[playerIndex].disconnectedAt = Date.now();
          const clientId = Object.keys(usersByClientId).find(id => 
            usersByClientId.get(id).socketId === socket.id
          );
          if (clientId && usersByClientId.has(clientId)) {
            const userData = usersByClientId.get(clientId);
            userData.isConnected = false;
            userData.lastDisconnected = Date.now();
            userData.socketId = socket.id;
          }
          io.to(roomId).emit('playerStatus', {
            players: room.players
          });
          const wasDrawing = room.currentDrawer && room.currentDrawer.id === socket.id && (room.status === 'playing' || room.status === 'selecting');
          if (wasDrawing) {
            console.log(`Drawer ${playerName} disconnected during their turn`);
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
            io.to(roomId).emit('chatMessage', drawerLeftMessage);
            io.to(roomId).emit('drawerLeft', { drawerName: playerName });
            if (room.timer) {
              clearInterval(room.timer);
              room.timer = null;
            }
            handlePlayerLeave(socket, roomId, 0);
            setTimeout(() => {
              if (rooms.has(roomId)) {
                startRound(roomId);
              }
            }, 2000);
          } else {
            setTimeout(() => {
              const currentRoom = rooms.get(roomId);
              if (currentRoom) {
                const player = currentRoom.players.find(p => p.id === socket.id);
                if (player && !player.isConnected) {
                  handlePlayerLeave(socket, roomId, 0);
                }
              }
            }, 30000);
          }
        }
      }
    }
  });

  function leaveRoom(socket, roomId) {
    handlePlayerLeave(socket, roomId, 0);
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
      if (player.hasGuessedCorrectly) {
        const chatMessage = {
          id: uuidv4(),
          playerId: socket.id,
          username: player.username,
          message,
          timestamp: Date.now(),
          fromPlayerWhoGuessed: true,
          fromCorrectGuesser: true
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
      if (room.status === 'playing') {
        const normalizedGuess = message.toLowerCase().trim();
        const normalizedWord = room.word.toLowerCase().trim();
        const isExactMatch = normalizedGuess === normalizedWord;
        const isCloseEnough = normalizedGuess.length > 6 && 
                            normalizedWord.length > 6 && 
                            levenshteinDistance(normalizedGuess, normalizedWord) === 1;
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
          io.to(socket.id).emit('wordGuessed', {
            word: room.word
          });
          io.to(socket.id).emit('wordHint', {
            hint: room.word,
            hintNumber: 3,
            fullWord: true
          });
          const allNonDrawersGuessed = room.players.filter(p => !p.disconnected).every(p => 
            p.id === room.currentDrawer.id || p.hasGuessedCorrectly || p.disconnected
          );
          if (allNonDrawersGuessed) {
            clearInterval(room.timer);
            setTimeout(() => {
              endRound(roomId);
            }, 1500);
          }
        } else if (isCloseGuess) {
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
          io.to(roomId).emit('chatMessage', closeGuessMessage);
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
        } else {
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
          room.players.forEach(p => {
            if (p.hasGuessedCorrectly || p.isDrawing || !p.hasGuessedCorrectly) {
              io.to(p.id).emit('chatMessage', chatMessage);
            }
          });
        }
      } else {
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
  
  // Update room activity tracker in drawing handler
  socket.on('drawing', (data) => {
    try {
      const roomId = findUserRoom(socket.id);
      if (!roomId) {
        console.error('No room found for socket ID:', socket.id);
        return;
      }
      
      // Get room and update last activity
      const room = rooms.get(roomId);
      if (!room) {
        console.error('Room not found:', roomId);
        return;
      }
      
      room.lastActivity = Date.now();
      
      if (room.currentDrawer && room.currentDrawer.id !== socket.id) {
        console.log('Ignoring drawing from non-drawer:', socket.id);
        return;
      }
      
      // Handle different types of drawing data
      if (data.type === 'clear' || data.clear) {
        console.log(`Clearing canvas in room ${roomId}`);
        room.drawingHistory = [];
        io.to(roomId).emit('drawingData', { clear: true });
        return;
      }
      
      if (data.fill) {
        // Handle fill events
        if (typeof data.x === 'number' && typeof data.y === 'number' && data.color) {
          console.log(`Received fill event from ${socket.id} to room ${roomId}: Fill at (${data.x},${data.y}) with color ${data.color}`);
          room.drawingHistory.push(data);
          io.to(roomId).emit('drawingData', data);
        } else {
          console.error('Invalid fill coordinates:', data);
        }
        return;
      }
      
      // Handle line drawing
      if (typeof data.x0 === 'number' && 
          typeof data.y0 === 'number' && 
          typeof data.x1 === 'number' && 
          typeof data.y1 === 'number') {
        console.log(`Drawing line from (${data.x0},${data.y0}) to (${data.x1},${data.y1})`);
        room.drawingHistory.push(data);
        io.to(roomId).emit('drawingData', data);
      } else {
        console.error('Invalid drawing coordinates received:', data);
      }
    } catch (error) {
      console.error('Error handling drawing data:', error);
    }
  });
  
  socket.on('clearCanvas', () => {
    try {
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
      room.drawingHistory = [];
      io.to(roomId).emit('canvasCleared');
    } catch (error) {
      console.error('Error handling clear canvas:', error);
    }
  });
});

// Update room cleanup interval logic 
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    // Update inactive player cleanup
    room.players = room.players.filter(player => {
      if (!player.isConnected && player.disconnectedAt && (now - player.disconnectedAt > 120000)) {
        console.log(`Removing inactive player ${player.username} from room ${roomId}`);
        return false;
      }
      return true;
    });

    // Only cleanup room if:
    // 1. No players left OR
    // 2. Room has been inactive for 30 minutes AND game is not in progress
    if (room.players.length === 0 || 
       (now - room.lastActivity > 1800000 && room.status !== 'playing' && room.status !== 'selecting')) {
      const roomTimer = room.timer;
      console.log(`Deleting inactive room: ${roomId}`);
      rooms.delete(roomId);
      if (roomTimer) {
        clearInterval(roomTimer);
      }
    }
  }

  // Update user session cleanup
  for (const [clientId, userData] of usersByClientId.entries()) {
    if (!userData.isConnected && userData.lastDisconnected && (now - userData.lastDisconnected > 3600000)) {
      console.log(`Cleaning up stale user session for client ${clientId}`);
      usersByClientId.delete(clientId);
    }
  }
  
  updatePublicRoomsList();
}, 60000); // Run cleanup every minute

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = server;
