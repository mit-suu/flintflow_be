import { User } from "../user/user.model.js"

/**
 * BPMN Flow 8 kết thúc ở "The account belongs to an organization and holds a role in it" — đó là mốc
 * onboarding xong. Ghi `onboardedAt` lần đầu người dùng vào được một org (tạo org, hoặc nhận mã mời);
 * các lần sau không ghi đè, để giữ đúng thời điểm onboarding thật.
 */
export const markOnboarded = async (userId: string): Promise<void> => {
  await User.updateOne({ _id: userId, onboardedAt: null }, { $set: { onboardedAt: new Date() } })
}
