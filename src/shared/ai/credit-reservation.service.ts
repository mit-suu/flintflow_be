import mongoose, { ClientSession } from "mongoose"
import { CreditWallet } from "../../modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../modules/credits/credit-transaction.model.js"
import { PricingConfig } from "../../modules/admin/pricing-config.model.js"
import { ActionType, AiActionError } from "./ai-action.types.js"

const DEFAULT_ACTION_COSTS: Record<string, number> = {
  [ActionType.GENERATE_SECTION]: 5,
  [ActionType.DIAGRAM_CLASSIFY]: 1,
  [ActionType.DIAGRAM_GENERATE]: 4,
  [ActionType.PRIORITY_RANKING]: 5,
  [ActionType.SCOPE_OUT_OF_SCOPE]: 5,
  [ActionType.CHAT]: 2,
  [ActionType.CHAT_DISCOVERY]: 2,
  [ActionType.SUMMARIZE_DOCUMENT]: 2  // Task 2b: tính phí như EXTRACT, 1 lần/document
}

export const getActionCost = async (actionType: string): Promise<number> => {
  try {
    const activePricing = await PricingConfig.findOne({ isActive: true })
    if (activePricing?.actionCosts && typeof activePricing.actionCosts[actionType] === "number") {
      return activePricing.actionCosts[actionType]
    }
  } catch (error) {
    console.warn(`[CreditReservation] Failed to query PricingConfig, using default cost for '${actionType}'`)
  }

  return DEFAULT_ACTION_COSTS[actionType] ?? 2
}

export const getOrCreateWallet = async (
  userId: string,
  session?: ClientSession
) => {
  const options = session ? { session } : {}
  let wallet = await CreditWallet.findOne({ userId }, null, options)

  if (!wallet) {
    const created = await CreditWallet.create(
      [
        {
          userId: new mongoose.Types.ObjectId(userId),
          balance: 100, // Initial free tier credits
          reserved: 0
        }
      ],
      options
    )
    wallet = created[0]
  }

  return wallet
}

export const reserveCredit = async (
  userId: string,
  actionType: string,
  projectId?: string,
  session?: ClientSession
): Promise<number> => {
  const cost = await getActionCost(actionType)
  const wallet = await getOrCreateWallet(userId, session)

  const available = wallet.balance - wallet.reserved
  if (available < cost) {
    throw new AiActionError(
      402,
      `Không đủ credit. Yêu cầu: ${cost} credit, Khả dụng: ${available} credit.`,
      "INSUFFICIENT_CREDIT",
      { cost, available, balance: wallet.balance, reserved: wallet.reserved }
    )
  }

  const options = session ? { session } : {}

  wallet.reserved += cost
  await wallet.save(options)

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
        actionType,
        amount: cost,
        type: "reserve",
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )

  return cost
}

export const deductCredit = async (
  userId: string,
  actionType: string,
  cost: number,
  projectId?: string,
  session?: ClientSession
): Promise<void> => {
  const options = session ? { session } : {}
  const wallet = await CreditWallet.findOne({ userId }, null, options)

  if (!wallet) return

  wallet.balance = Math.max(0, wallet.balance - cost)
  wallet.reserved = Math.max(0, wallet.reserved - cost)
  await wallet.save(options)

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
        actionType,
        amount: cost,
        type: "deduct",
        balanceAfter: wallet.balance
      }
    ],
    options
  )
}

export const releaseCredit = async (
  userId: string,
  actionType: string,
  cost: number,
  projectId?: string,
  session?: ClientSession
): Promise<void> => {
  const options = session ? { session } : {}
  const wallet = await CreditWallet.findOne({ userId }, null, options)

  if (!wallet) return

  wallet.reserved = Math.max(0, wallet.reserved - cost)
  await wallet.save(options)

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: projectId ? new mongoose.Types.ObjectId(projectId) : null,
        actionType,
        amount: cost,
        type: "release",
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )
}
