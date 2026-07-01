# Blockchain-Based Voting System

https://blockchain300809.web.app/  hosted here

A secure, transparent, and immutable blockchain-based e-voting system designed to prevent vote tampering and ensure voter integrity. This project implements a decentralized ledger using AES-256 encryption, WebSocket integration for real-time updates, and a Node.js + Express backend.

## Features
- **Blockchain Core**: Immutable ledger storing votes securely.
- **Real-Time Updates**: WebSocket integration for live vote counting and dashboard updates.
- **Admin Dashboard**: For the Election Commission to manage candidates, verify the blockchain, toggle voting periods, and load voter files.
- **Polling Agent Panel**: Agents issue OTPs to voters after verification.
- **Voter Portal**: Voters use their unique ID, fingerprint hash, and OTP to cast a vote securely.
- **Automated Tunneling**: Built-in support to expose the local server using `localhost.run` via SSH tunnels.
- **Firebase Sync**: Real-time synchronization to Firebase for remote database and state management.

## Tech Stack
- **Backend API**: Node.js, Express.js
- **Blockchain Engine**: Node.js (and P2P C++ nodes).
- **Real-time Communication**: WebSockets (`ws`)
- **Frontend**: HTML/CSS/JS (Vanilla) served as a Single Page Application (SPA).
- **Process Management**: PM2 (for background auto-start).

## Work Process (How it Works)

1. **Setup & Initialization**: 
   The server starts up and initializes the blockchain ledger. If a previous ledger exists (`election_data.enc`), it is decrypted and loaded into memory.

2. **Voter Registration & Verification**:
   The Election Commission (Admin) loads a list of eligible voters. 
   A Polling Agent verifies the physical identity of a voter at the booth and triggers an OTP for them.

3. **Voting Phase**:
   - The Admin enables "Voting Day".
   - The Voter logs into the voting portal using their Voter ID, fingerprint, and the OTP provided by the agent.
   - The Voter selects a candidate.
   - The vote is encrypted and bundled into a block. The block is mined (Proof of Work) and appended to the blockchain.

4. **Real-time Tallying**:
   - As blocks are added, the Node.js server broadcasts the updated tally via WebSockets to the Admin dashboard.
   - The blockchain can be audited at any time. Any tampering with the `.enc` file will break the chain validation, alerting the admin.

## Installation and Execution

### Prerequisites
- [Node.js](https://nodejs.org/) (v16+)
- Windows (for the provided `.bat` scripts, though Linux/Mac users can run the `api-server` manually)

### Running the Server Manually
1. Clone the repository.
2. Double-click the `START_SERVER.bat` file.
3. This will automatically:
   - Start an SSH tunnel to make the server accessible over the internet (via `localhost.run`).
   - Install necessary Node.js dependencies (`npm install`).
   - Start the backend API and WebSocket server on `http://localhost:3000`.
4. Access the different portals locally (or via the generated tunnel URL):
   - **Admin**: `http://localhost:3000/admin`
   - **Agent**: `http://localhost:3000/agent`
   - **Voter**: `http://localhost:3000/vote`
   - **Register**: `http://localhost:3000/register`

### Background Auto-Start (Windows)
To run the server continuously in the background using PM2:
1. Run `SETUP_AUTOSTART.bat` as Administrator.
2. This script installs PM2, configures the `ecosystem.config.js`, and sets up PM2 to start automatically on Windows boot.
