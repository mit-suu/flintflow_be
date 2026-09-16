import swaggerJsdoc from "swagger-jsdoc"

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "FlintFlow API",
      version: "1.0.0",
      description:
        "FlintFlow Backend API. Nội dung SRS nằm trong Spine (một document mỗi project) và chỉ đổi qua op " +
        "(POST /projects/{id}/changes, step runner). Hợp đồng chuẩn của Spine/pipeline/change/flags/export là " +
        "docs/api/pipeline-contract.md — swagger ở đây sinh từ JSDoc của route và có thể tóm tắt hơn.",
      contact: {
        name: "FlintFlow Team"
      }
    },
    servers: [
      {
        url: "/",
        description: "Current Server (Auto-detected)"
      },
      {
        url: "https://flintflow-be-a5huepbqe7apa0ft.southeastasia-01.azurewebsites.net",
        description: "Azure Production Server"
      },
      {
        url: "http://localhost:5000",
        description: "Local Development Server"
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
    tags: [
      { name: "Auth", description: "Đăng ký, đăng nhập, refresh token, Google OAuth" },
      { name: "Projects", description: "Metadata dự án (tên, domain, trạng thái) và tài liệu upload" },
      { name: "Chat Sessions", description: "Phiên chat: một session pipeline mỗi project, các session khác hỏi đáp / sửa qua change flow" },
      { name: "Spine", description: "Đọc Spine, áp lô op, impact, preview, undo, reconcile, traceability" },
      { name: "Pipeline", description: "Step registry, chạy step (SSE), gate, resume, tiến độ" },
      { name: "Diagram", description: "Render sơ đồ PlantUML và tải file SVG/PNG" },
      { name: "Render", description: "Assemble RenderedDocument và xuất Word" },
      { name: "Export", description: "Xem trước RenderedDocument thành .docx" },
      { name: "Notifications", description: "Thông báo in-app" },
      { name: "Billing", description: "Gói, mua credit qua payment_service" },
      { name: "AI Actions", description: "Gọi action ngoài pipeline (chat, summarize_document) và ước tính giá" },
      { name: "Admin", description: "Chỉ đọc: người dùng, số liệu, chi phí AI" }
    ],
    security: []
  },
  apis: [
    "./src/modules/**/*.route.ts",
    "./dist/modules/**/*.route.js",
    "./src/shared/ai/*.route.ts",
    "./dist/shared/ai/*.route.js"
  ]
}

export const specs = swaggerJsdoc(options)
