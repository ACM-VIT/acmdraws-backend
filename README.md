![ACM Header](https://user-images.githubusercontent.com/14032427/92643737-e6252e00-f2ff-11ea-8a51-1f1b69caba9f.png)

<h1 align="center">acmdraws-backend</h1>

<p align="center">
  <strong>A Node.js backend for a real-time multiplayer drawing and guessing game.</strong>
</p>

<p align="center">
  <a href="https://acmvit.in/" target="_blank">
    <img alt="Made by ACM" src="https://img.shields.io/badge/MADE%20BY-ACM%20VIT-blue?style=for-the-badge"/>
  </a>
  <!-- <img alt="license" src="https://img.shields.io/badge/License-ISC-green.svg?style=for-the-badge" /> -->
</p>

---

## 🚀 Overview

**acmdraws-backend** is the server-side application that powers a multiplayer drawing and guessing game inspired by skribbl.io. It handles game logic, player management, real-time communication using WebSockets, and serves game assets.

## 🌟 Features

- **Real-time Multiplayer**: Supports multiple players in a room.
- **Room Management**: Create public or private game rooms.
- **Game Logic**: Manages rounds, turns, word selection, drawing, guessing, and scoring.
- **WebSocket Communication**: Uses Socket.IO for real-time updates between clients and server.
- **Customizable Game Settings**: Allows hosts to configure rounds, draw time, and custom words.
- **Word Dictionary**: Includes a default dictionary and supports custom word lists.
- **Player Avatars**: Basic avatar support for players.
- **Chat Functionality**: In-game chat for players.
- **Hint System**: Provides hints during the drawing phase.
- **Server Configuration**: Allows for maintenance mode and other server-side settings.
- **Health Check Endpoint**: `/health` endpoint to monitor server status.

## 💻 Tech Stack

- **Node.js**: JavaScript runtime environment.
- **Express.js**: Web application framework for Node.js.
- **Socket.IO**: Library for real-time, bidirectional and event-based communication.

## ⚙️ Installation

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd acmdraws-backend
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure the server (optional):**
    Modify `server.js` for server-specific settings in the `SERVER_CONFIG` object.

4.  **Run the server:**
    ```bash
    npm start
    ```
    The server will typically run on `http://localhost:3001` or the port specified in your `Procfile` or environment variables.

## 🔧 API Endpoints

-   `GET /health`: Returns the health status of the server.
-   `GET /api/config`: Returns the current server configuration.

## 🔌 WebSocket Events

The server uses Socket.IO to handle various game events. Key events include:

-   `identifyUser`: Client identifies itself to the server.
-   `createRoom`: Client requests to create a new game room.
-   `joinRoom`: Client requests to join an existing game room.
-   `startGame`: Host starts the game with specified settings.
-   `selectWord`: Drawer selects a word to draw.
-   `drawing`: Drawer sends drawing data.
-   `chatMessage`: Client sends a chat message or guess.
-   `leaveRoom`: Client leaves the current room.
-   `getPublicRooms`: Client requests a list of public rooms.
-   `clearCanvas`: Drawer clears the canvas.

The server emits events like:

-   `serverConfig`: Sends server configuration to the client.
-   `roomCreated`: Confirms room creation.
-   `joinedRoom`: Confirms player has joined a room.
-   `playerJoined`: Notifies room about a new player.
-   `playerLeft`: Notifies room when a player leaves.
-   `gameStarted`: Notifies clients that the game has started.
-   `wordSelection`: Sends word options to the drawer.
-   `roundStart`: Notifies clients that a new round/turn has started.
-   `timeUpdate`: Sends remaining time updates.
-   `drawingData`: Broadcasts drawing data to clients in the room.
-   `chatMessage`: Broadcasts chat messages.
-   `wordGuessed`: Notifies a player their guess was correct.
-   `turnEnded`: Notifies clients that the current turn has ended.
-   `gameEnded`: Notifies clients that the game has ended.
-   `errorMessage`: Sends an error message to a client.
-   `publicRooms`: Sends a list of public rooms.
-   `canvasCleared`: Notifies clients that the canvas has been cleared.
-   `wordHint`: Sends a hint for the current word.

## ⚙️ Project Management

-   Use **Git** for version control and code management.
-   Follow standard Gitflow or a similar branching model.
-   Push to feature branches and create pull requests for review before merging into `main` or `develop` branches.


