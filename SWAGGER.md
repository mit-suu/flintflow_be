# Swagger API Documentation

## Overview
The FlintFlow API includes comprehensive Swagger/OpenAPI documentation that is automatically generated from JSDoc comments in the route files.

## Accessing Swagger UI

Once the server is running, you can access the interactive API documentation at:

```
http://localhost:5000/api-docs
```

## Features

### 📚 Interactive Documentation
- View all API endpoints with descriptions
- See request and response schemas
- Try out API calls directly from the browser

### 🔐 Authentication Testing
1. Register a new user or login
2. Copy the `accessToken` from the response
3. Click the "Authorize" button in Swagger UI
4. Paste the token: `Bearer <accessToken>`
5. Protected endpoints will now include the token automatically

### 📝 Available Endpoints

#### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login user
- `POST /api/v1/auth/logout` - Logout user

#### Users
- `GET /api/v1/users/me` - Get current user (requires auth)
- `GET /api/v1/users/:id` - Get user by ID (requires auth)

## Request/Response Examples

### Register
```json
Request:
{
  "email": "user@example.com",
  "password": "securepassword"
}

Response:
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "507f1f77bcf86cd799439011",
      "email": "user@example.com",
      "createdAt": "2024-06-08T12:00:00Z",
      "updatedAt": "2024-06-08T12:00:00Z"
    }
  }
}
```

### Login
```json
Request:
{
  "email": "user@example.com",
  "password": "securepassword"
}

Response:
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "507f1f77bcf86cd799439011",
      "email": "user@example.com",
      "createdAt": "2024-06-08T12:00:00Z",
      "updatedAt": "2024-06-08T12:00:00Z"
    }
  }
}
```

### Get Current User
```
GET /api/v1/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

Response:
{
  "success": true,
  "message": "User fetched successfully",
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "email": "user@example.com",
    "createdAt": "2024-06-08T12:00:00Z",
    "updatedAt": "2024-06-08T12:00:00Z"
  }
}
```

## Configuration

The Swagger configuration is defined in `src/config/swagger.ts`:

- **Title**: FlintFlow API
- **Version**: 1.0.0
- **Servers**: Development (localhost:5000) and Production
- **Security Scheme**: Bearer JWT Token

## How to Add New Endpoints to Swagger

1. Add JSDoc comments to your route with `@swagger` tags
2. Define the path, method, parameters, and responses
3. Reference schemas from `#/components/schemas/`

Example:
```typescript
/**
 * @swagger
 * /api/v1/example:
 *   get:
 *     summary: Get example
 *     tags:
 *       - Example
 *     responses:
 *       200:
 *         description: Success
 */
router.get("/example", exampleController.getExample)
```

## Tips

- Use "Try it out" button to test endpoints directly
- The authorization persists across requests
- Schemas are defined in the `components.schemas` section
- The refresh token is stored as an HTTP-only cookie

## Troubleshooting

**Swagger UI not loading?**
- Ensure the server is running on port 5000
- Check that `swagger-jsdoc` and `swagger-ui-express` are installed
- Verify the routes are properly documented with JSDoc

**Can't authenticate?**
- Make sure to include "Bearer " prefix before the token
- Check that the access token is valid (not expired)
- Verify the Authorization header is being sent
