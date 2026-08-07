import { v2 as cloudinary } from "cloudinary"
import { env } from "../../config/env.js"
import { Readable } from "stream"

const rawCloudName = env.CLOUDINARY_CLOUD_NAME || ""
const cloudName = rawCloudName.trim().toLowerCase()

const isValidCloudName = /^[a-z0-9-]+$/.test(cloudName)

if (isValidCloudName && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: env.CLOUDINARY_API_KEY || "",
    api_secret: env.CLOUDINARY_API_SECRET || ""
  })
} else {
  // Do not call cloudinary.config with an invalid cloud name to avoid runtime exceptions
  // Uploads will fail with a clearer error from `uploadFileToCloudinary`.
}

export const uploadFileToCloudinary = async (
  file: Express.Multer.File,
  options?: { folder?: string }
): Promise<{ public_id: string; secure_url: string }> => {
  if (!cloudName || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    const provided = rawCloudName || "(empty)"
    throw new Error(`Cloudinary credentials are not configured or cloud name is invalid. Provided: ${provided}`)
  }

  return await new Promise((resolve, reject) => {
    const originalName = file.originalname || "file"
    const extensionIndex = originalName.lastIndexOf(".")
    const publicId = extensionIndex > 0 ? originalName.substring(0, extensionIndex) : originalName

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options?.folder || "flintflow",
        resource_type: "raw",
        use_filename: true,
        unique_filename: true,
        public_id: publicId
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Cloudinary upload failed"))
          return
        }

        resolve({
          public_id: result.public_id,
          secure_url: result.secure_url
        })
      }
    )

    const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || "")
    const readable = Readable.from(buffer)
    readable.pipe(uploadStream)
  })
}
