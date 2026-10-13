/**
 * Nạp mọi module khai báo job (`defineJob`) — worker phải biết đủ processor trước khi nhận job, và driver inline cần
 * đủ job định kỳ trước khi `startInlineSchedules`. Thêm job mới ⇒ thêm module của nó vào đây.
 */
export const loadJobDefinitions = async (): Promise<void> => {
  await Promise.all([
    import("./modules/import/extract-jobs.js"),
    import("./modules/import/finalize-jobs.js"),
    import("./modules/import/credit-flow.service.js"),
    import("./modules/change-request/embedding/embedding-sync.service.js"),
    import("./shared/email/email.service.js"),
    import("./shared/ai/credit-reservation.jobs.js")
  ])
}
