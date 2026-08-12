import dotenv from "dotenv"

dotenv.config()

import app from "./app.js"

console.log("Loaded Cloudinary cloud name:", process.env.CLOUDINARY_CLOUD_NAME)

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})