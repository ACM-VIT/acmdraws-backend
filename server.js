const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000,https://enrollments-25.vercel.app',
    methods: ['GET', 'POST']
  },
  path: '/skribbl',
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 30000,
  maxHttpBufferSize: 5e6
});

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
  
  room.timer = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room) {
      clearInterval(room.timer);
      return;
    }
    
    room.timeLeft -= 1;
    
    io.to(roomId).emit('timeUpdate', { timeLeft: room.timeLeft });
    
    if (room.status === 'playing' && room.word && room.hintsRevealed) {
      const totalTime = room.drawTime + 10;
      const hintIntervals = Math.floor(totalTime / 3);
      
      if (room.timeLeft === Math.floor(totalTime - hintIntervals) && room.hintsRevealed.count === 0) {
        revealHint(roomId, 1);
      }
      
      if (room.timeLeft === Math.floor(totalTime - 2 * hintIntervals) && room.hintsRevealed.count === 1) {
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
  
  availablePositions = availablePositions.sort(() => 0.5 - Math.random());
  
  const toReveal = hintNumber === 1 
    ? Math.max(1, Math.floor(availablePositions.length * 0.25)) 
    : Math.max(1, Math.floor(availablePositions.length * 0.5));
  
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
  
  console.log(`Hint ${hintNumber} revealed for word "${room.word}" in room ${roomId}: ${maskedWord}`);
}

function generateMaskedWordWithHints(word, revealedPositions) {
  return word.split('').map((char, index) => {
    if (char === ' ') return ' ';
    if (revealedPositions.includes(index)) return char;
    return '_';
  }).join('');
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
  
  room.players.forEach(player => {
    player.isDrawing = player.id === nextDrawer.id;
    player.hasGuessedCorrectly = false;
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
  
  io.to(room.id).emit('roundStarted', {
    gameState: 'playing',
    drawer: room.currentDrawer,
    drawerName: drawerPlayer.username,
    timeLeft: room.timeLeft,
    word: hiddenWord
  });
  
  io.to(room.currentDrawer).emit('roundStarted', {
    gameState: 'playing',
    drawer: room.currentDrawer,
    drawerName: drawerPlayer.username,
    word: selectedWord,
    timeLeft: room.timeLeft,
    isDrawing: true
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
  
  io.to(roomId).emit('roundEnded', {
    word: room.word,
    players: room.players
  });
  
  console.log(`Round ended in room ${roomId}. Waiting 5 seconds before next round.`);
  
  setTimeout(() => {
    if (rooms.has(roomId)) {
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

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  const reconnectUser = async () => {
    const previousSession = disconnectedUsers.get(socket.handshake.address);
    if (previousSession) {
      const { roomId, username, avatar } = previousSession;
      
      if (rooms.has(roomId)) {
        socket.emit('rejoinPrompt', { roomId, username });
        
        disconnectedUsers.delete(socket.handshake.address);
        return true;
      }
    }
    return false;
  };
  
  reconnectUser();
  
  socket.on('createRoom', ({ username, isPublic = false, avatar = 0 }) => {
    try {
      console.log(`Creating ${isPublic ? 'public' : 'private'} room for ${username} (${socket.id})`);
      
      const room = createRoomState(isPublic, socket.id, username, avatar);
      
      console.log(`Room ${room.id} created with host ID: ${room.hostId}`);
      console.log(`Players in room: `, room.players);
      
      users.set(socket.id, { 
        username, 
        roomId: room.id,
        avatar,
        address: socket.handshake.address
      });
      
      socket.join(room.id);
      
      socket.emit('roomCreated', { 
        roomId: room.id
      });
      
      console.log(`Room created: ${room.id} by ${username}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('errorMessage', 'Failed to create room');
    }
  });
  
  socket.on('joinRoom', ({ roomId, username, avatar = 0 }) => {
    try {
      if (!rooms.has(roomId)) {
        socket.emit('errorMessage', 'Room not found');
        return;
      }
      
      const room = rooms.get(roomId);
      
      if (room.players.length >= room.maxPlayers) {
        socket.emit('errorMessage', 'Room is full');
        return;
      }
      
      if (room.status !== 'waiting' && room.gameMode !== 'Normal') {
        socket.emit('errorMessage', 'Game in progress, cannot join');
        return;
      }
      
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
      
      console.log(`${username} joined room: ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('errorMessage', 'Failed to join room');
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
      
      if (room.status === 'playing' && 
          message.toLowerCase().trim() === room.word.toLowerCase()) {
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
        
        const allNonDrawersGuessed = room.players.every(p => 
          p.id === room.currentDrawer || p.hasGuessedCorrectly);
        
        if (allNonDrawersGuessed) {
          clearInterval(room.timer);
          
          setTimeout(() => {
            endRound(user.roomId);
          }, 1500);
        }
      } else {
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
        
        room.players.forEach(p => {
          if (!p.hasGuessedCorrectly || p.isDrawing) {
            io.to(p.id).emit('chatMessage', chatMessage);
          }
        });
      }
    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });
  
  socket.on('drawing', (drawingData) => {
    try {
      const user = users.get(socket.id);
      if (!user) {
        console.error(`Drawing data received from unknown user: ${socket.id}`);
        return;
      }
      
      const room = rooms.get(user.roomId);
      if (!room) {
        console.error(`Drawing data received for unknown room from user: ${user.username} (${socket.id})`);
        return;
      }
      
      if (room.currentDrawer !== socket.id || room.status !== 'playing') {
        console.error(`Drawing data received from non-drawer: ${user.username} (${socket.id})`);
        return;
      }
      
      console.log(`Drawing data received from ${user.username} in room ${room.id}`);
      
      if (!room.drawingHistory) {
        room.drawingHistory = [];
      }
      
      if (room.drawingHistory.length > 1000) {
        room.drawingHistory.shift();
      }
      
      room.drawingHistory.push(drawingData);
      
      socket.to(user.roomId).emit('drawingData', drawingData);
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
      console.log(`User disconnected: ${socket.id}`);
      
      const user = users.get(socket.id);
      if (!user) return;
      
      const room = rooms.get(user.roomId);
      if (!room) return;
      
      if (user.address) {
        disconnectedUsers.set(user.address, {
          roomId: user.roomId,
          username: user.username,
          avatar: user.avatar,
          timestamp: Date.now()
        });
        
        setTimeout(() => {
          if (disconnectedUsers.has(user.address)) {
            disconnectedUsers.delete(user.address);
          }
        }, 10 * 60 * 1000);
      }
      
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const isHost = room.players[playerIndex].isHost;
        const isDrawer = room.players[playerIndex].id === room.currentDrawer;
        
        room.players[playerIndex].disconnected = true;
        
        setTimeout(() => {
          if (!rooms.has(user.roomId)) return;
          
          const room = rooms.get(user.roomId);
          const playerIndex = room.players.findIndex(p => p.id === socket.id);
          
          if (playerIndex !== -1 && room.players[playerIndex].disconnected) {
            const isHost = room.players[playerIndex].isHost;
            const isDrawer = room.players[playerIndex].id === room.currentDrawer;
            
            room.players.splice(playerIndex, 1);
            
            if (room.players.length === 0) {
              if (room.status === 'waiting') {
                clearInterval(room.timer);
                rooms.delete(user.roomId);
                
                if (room.isPublic) {
                  removePublicRoom(user.roomId);
                }
                
                console.log(`Room deleted: ${user.roomId}`);
              }
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
        }, 2 * 60 * 1000);
        
        io.to(user.roomId).emit('playerStatus', {
          players: room.players
        });
        
        io.to(user.roomId).emit('chatMessage', {
          id: uuidv4(),
          playerId: 'system',
          username: 'System',
          message: `${user.username} disconnected (waiting 2 minutes for reconnection)`,
          isSystemMessage: true,
          timestamp: Date.now()
        });
      }
      
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
      
      const playerIndex = room.players.findIndex(p => 
        p.username === username && p.disconnected === true
      );
      
      if (playerIndex !== -1) {
        room.players[playerIndex].id = socket.id;
        room.players[playerIndex].disconnected = false;
        
        users.set(socket.id, { 
          username, 
          roomId,
          avatar,
          address: socket.handshake.address
        });
        
        socket.join(roomId);
        
        updatePublicRoomInfo(roomId);
        
        io.to(roomId).emit('playerStatus', { 
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
        
        socket.emit('rejoinedRoom', {
          roomId,
          players: room.players,
          gameState: room.status,
          round: room.round,
          totalRounds: room.totalRounds,
          currentDrawer: room.currentDrawer,
          timeLeft: room.timeLeft,
          chatMessages: room.chatHistory || [],
          word: room.currentDrawer === socket.id ? room.word : room.word?.replace(/[a-zA-Z]/g, '_')
        });
        
        socket.emit('canvasCleared');
        
        if (room.drawingHistory && room.drawingHistory.length > 0) {
          socket.emit('drawingBatch', room.drawingHistory);
        }
        
        console.log(`${username} reconnected to room: ${roomId}`);
      } else {
        const existingPlayerIndex = room.players.findIndex(p => p.username === username);
        
        if (existingPlayerIndex !== -1) {
          room.players[existingPlayerIndex].id = socket.id;
          room.players[existingPlayerIndex].disconnected = false;
          
          if (room.currentDrawer === room.players[existingPlayerIndex].id) {
            room.currentDrawer = socket.id;
          }
          
          users.set(socket.id, {
            username,
            roomId,
            avatar,
            address: socket.handshake.address
          });
          
          socket.join(roomId);
          
          io.to(roomId).emit('playerStatus', {
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
          
          socket.emit('rejoinedRoom', {
            roomId,
            players: room.players,
            gameState: room.status,
            round: room.round,
            totalRounds: room.totalRounds,
            currentDrawer: room.currentDrawer,
            timeLeft: room.timeLeft,
            chatMessages: room.chatHistory || [],
            word: room.currentDrawer === socket.id ? room.word : room.word?.replace(/[a-zA-Z]/g, '_')
          });
          
          socket.emit('canvasCleared');
          
          if (room.drawingHistory && room.drawingHistory.length > 0) {
            socket.emit('drawingBatch', room.drawingHistory);
          }
          
          console.log(`${username} reconnected to room: ${roomId}`);
        } else {
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