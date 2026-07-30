import swaggerJsdoc from "swagger-jsdoc"

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "FlintFlow API",
      version: "1.0.0",
      description: "FlintFlow Backend API Documentation",
      contact: {
        name: "FlintFlow Team"
      }
    },
    servers: [
      {
        url: "http://localhost:5000",
        description: "Development server"
      },
      {
        url: "https://api.flintflow.com",
        description: "Production server"
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT Access Token"
        }
      },
      schemas: {
        User: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "User ID"
            },
            email: {
              type: "string",
              format: "email",
              description: "User email address"
            },
            createdAt: {
              type: "string",
              format: "date-time",
              description: "User creation date"
            },
            updatedAt: {
              type: "string",
              format: "date-time",
              description: "User last update date"
            }
          }
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "user@example.com"
            },
            password: {
              type: "string",
              format: "password",
              example: "securepassword",
              minLength: 6
            }
          }
        },
        RegisterRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              example: "user@example.com"
            },
            password: {
              type: "string",
              format: "password",
              example: "securepassword",
              minLength: 6
            }
          }
        },
        AuthResponse: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                accessToken: {
                  type: "string",
                  description: "JWT Access Token"
                },
                user: {
                  $ref: "#/components/schemas/User"
                }
              }
            },
            error: {
              type: "object",
              nullable: true,
              example: null
            }
          }
        },
        ErrorResponse: {
          type: "object",
          properties: {
            data: {
              type: "object",
              nullable: true,
              example: null
            },
            error: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  example: "INVALID_CREDENTIALS"
                },
                message: {
                  type: "string",
                  example: "Invalid credentials"
                }
              }
            }
          }
        }
      }
    },
    security: []
  },
  apis: ["./src/modules/**/*.ts"]
}

export const specs = swaggerJsdoc(options)
