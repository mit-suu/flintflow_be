# FlintFlow Backend Setup Guide

## Prerequisites
- Node.js (v16+)
- MongoDB
- npm or yarn

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Update `.env` with your configuration:
   - Set `MONGO_URI` to your MongoDB connection string
   - Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to strong random strings
   - Configure `CLIENT_URL` for CORS

## Development

Start the development server:
```bash
npm run dev
```

The server will run on `http://localhost:5000` by default.

## Building

Build the TypeScript project:
```bash
npm run build
```

## Production

Start the production server:
```bash
npm start
```

## API Documentation

### Authentication Endpoints

**Register**
```
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Login**
```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Logout**
```
POST /api/v1/auth/logout
Authorization: Bearer <accessToken>
```

### User Endpoints

**Get Current User**
```
GET /api/v1/users/me
Authorization: Bearer <accessToken>
```

**Get User by ID**
```
GET /api/v1/users/:id
Authorization: Bearer <accessToken>
```

## Project Structure

```
src/
├── routes/           # API routes
├── controllers/      # Request handlers
├── services/         # Business logic
├── models/          # Database models
├── middlewares/     # Express middlewares
├── validators/      # Input validation
├── dtos/           # Data transfer objects
├── utils/          # Utility functions
├── config/         # Configuration
└── constants/      # Constants
```

## Features

- JWT-based authentication
- Refresh token rotation
- HTTP-only cookies
- Zod validation
- MongoDB integration
- Centralized error handling
- TypeScript support

## Environment Variables

See `.env.example` for all available environment variables.
