# FlintFlow Backend API

Complete backend implementation for FlintFlow application with JWT authentication, user management, and comprehensive API documentation.

## 🚀 Quick Start

### Prerequisites
- Node.js v16+
- MongoDB
- npm or yarn

### Installation

1. **Install dependencies:**
```bash
npm install
```

2. **Create environment file:**
```bash
cp .env.example .env
```

3. **Configure environment variables:**
```env
MONGO_URI=mongodb://localhost:27017/flintflow
JWT_ACCESS_SECRET=your_access_secret_key
JWT_REFRESH_SECRET=your_refresh_secret_key
CLIENT_URL=http://localhost:3000
```

4. **Start development server:**
```bash
npm run dev
```

The API will be available at `http://localhost:5000`

## 📚 API Documentation

Interactive Swagger documentation is available at:
```
http://localhost:5000/api-docs
```

See [SWAGGER.md](./SWAGGER.md) for detailed documentation.

## 🏗️ Project Structure

```
src/
├── routes/          # API route definitions
├── controllers/     # Request handlers (thin layer)
├── services/        # Business logic layer
├── models/         # MongoDB Mongoose schemas
├── middlewares/    # Express middlewares
├── validators/     # Request validation (Zod)
├── dtos/          # Data Transfer Objects
├── utils/         # Utility functions
├── config/        # Configuration files
├── constants/     # Application constants
└── prompts/       # Prompt templates
```

## 🔐 Authentication

### JWT Tokens
- **Access Token**: 15 minutes validity
- **Refresh Token**: 7 days validity, stored in HTTP-only cookies

### Endpoints

#### Register
```bash
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

#### Login
```bash
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

#### Logout
```bash
POST /api/v1/auth/logout
Authorization: Bearer <accessToken>
```

## 👤 User Endpoints

#### Get Current User
```bash
GET /api/v1/users/me
Authorization: Bearer <accessToken>
```

#### Get User by ID
```bash
GET /api/v1/users/:id
Authorization: Bearer <accessToken>
```

## 📦 Available Scripts

```bash
npm run dev       # Start development server with auto-reload
npm run build     # Build TypeScript to JavaScript
npm start         # Start production server
```

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: MongoDB with Mongoose
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Zod
- **Password Hashing**: Bcrypt
- **API Documentation**: Swagger/OpenAPI
- **Logging**: Morgan
- **CORS**: Enabled for frontend integration

## 🔒 Security Features

- ✅ JWT-based authentication
- ✅ Refresh token rotation
- ✅ HTTP-only secure cookies
- ✅ Password hashing with bcrypt (10 salt rounds)
- ✅ Input validation with Zod
- ✅ CORS protection
- ✅ Centralized error handling

## 📝 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| PORT | No | Server port (default: 5000) |
| NODE_ENV | No | Environment (development/production) |
| MONGO_URI | Yes | MongoDB connection string |
| CLIENT_URL | No | Frontend URL for CORS |
| JWT_ACCESS_SECRET | Yes | Secret for access token |
| JWT_REFRESH_SECRET | Yes | Secret for refresh token |
| ACCESS_TOKEN_EXPIRES | No | Access token expiry (default: 15m) |
| REFRESH_TOKEN_EXPIRES | No | Refresh token expiry (default: 7d) |

## 🧪 Testing with Swagger UI

1. Open http://localhost:5000/api-docs
2. Register a new user or login
3. Copy the `accessToken` from the response
4. Click "Authorize" button and paste: `Bearer <token>`
5. Test protected endpoints

## 📖 Documentation Files

- [SETUP.md](./SETUP.md) - Detailed setup guide
- [SWAGGER.md](./SWAGGER.md) - API documentation guide
- [guide.md](./guide.md) - Architecture guidelines

## 🐛 Troubleshooting

**Port already in use?**
```bash
# Change PORT in .env
PORT=3001
```

**MongoDB connection error?**
- Ensure MongoDB is running
- Check MONGO_URI in .env

**Swagger documentation not loading?**
- Verify server is running on port 5000
- Check browser console for errors
- Refresh the page

## 📅 Future Features

- [ ] Refresh token endpoint
- [ ] Email verification
- [ ] Password reset
- [ ] Rate limiting
- [ ] Admin dashboard
- [ ] API key authentication
- [ ] File upload
- [ ] Streaming API responses

## 📄 License

ISC

## 👥 Author

FlintFlow Team

---

**Developed with ❤️ using TypeScript and Express.js**
