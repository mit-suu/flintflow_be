/**
 * Spec mẫu (đúng dạng model trả) cho test renderer mockup và script xem thử `scripts/preview-screen-mockups.ts`.
 * Không dùng trong luồng chạy thật.
 */

import type { ScreenSpec } from "./screen-spec.js"

export const SIGNUP_SPEC: ScreenSpec = {
  title: "Create your account",
  path: "/signup",
  platforms: ["web", "mobile"],
  back: true,
  columns: 2,
  blocks: [
    {
      type: "fields",
      items: [
        { label: "Full name", required: true, placeholder: "Nguyen Van An" },
        { label: "Email", required: true, placeholder: "an.nguyen@example.com" },
        { label: "Password", required: true, kind: "password" },
        { label: "Date of birth", kind: "date", placeholder: "DD/MM/YYYY" }
      ]
    },
    { type: "checkbox", label: "I agree to the Terms of Use" },
    { type: "buttons", items: [{ label: "Create account", primary: true }, { label: "Sign up with Google" }] },
    { type: "link", text: "Already have an account? Log in" }
  ]
}

export const CART_SPEC: ScreenSpec = {
  title: "Shopping Cart (2)",
  path: "/cart",
  platforms: ["web", "mobile"],
  back: true,
  nav: ["Home", "Orders", "Cart (2)"],
  blocks: [
    {
      type: "items",
      items: [
        { name: "Galaxy S24 128GB", meta: "Black - In stock: 12", price: "18,990,000 VND", qty: 1 },
        { name: "AirPods Pro 2", meta: "White - In stock: 4", price: "5,490,000 VND", qty: 2 }
      ]
    },
    { type: "inline", placeholder: "Voucher code", button: "Apply" },
    { type: "summary", rows: [["Subtotal", "29,970,000 VND"], ["Discount", "-500,000 VND"], ["Total", "29,470,000 VND", true]] },
    { type: "buttons", items: [{ label: "Proceed to checkout", primary: true }, { label: "Continue shopping" }] }
  ]
}

export const INVENTORY_SPEC: ScreenSpec = {
  title: "Inventory",
  path: "/admin/inventory",
  platforms: ["web"],
  nav: ["Dashboard", "Products", "Inventory", "Orders"],
  tabs: ["All products", "Low stock", "Out of stock"],
  columns: 3,
  blocks: [
    { type: "search", placeholder: "Search by product name or SKU", button: "Search" },
    {
      type: "fields",
      items: [
        { label: "Category", kind: "select", placeholder: "All categories" },
        { label: "Warehouse", kind: "select", placeholder: "Ha Noi" },
        { label: "Updated from", kind: "date", placeholder: "01/11/2026" }
      ]
    },
    {
      type: "table",
      columns: ["SKU", "Product", "Category", "In stock", "Status"],
      rows: [
        ["SS-S24-128", "Galaxy S24 128GB", "Phones", "12", "Available"],
        ["AP-PRO2", "AirPods Pro 2", "Audio", "4", "Low stock"],
        ["MB-AIR-M3", "MacBook Air M3", "Laptops", "0", "Out of stock"]
      ]
    },
    { type: "buttons", items: [{ label: "Add stock", primary: true }, { label: "Export CSV" }] }
  ]
}

export const DELETE_POPUP_SPEC: ScreenSpec = {
  title: "Remove item",
  path: "/cart",
  platforms: ["web", "mobile"],
  popup: true,
  blocks: [
    { type: "text", text: "Remove Galaxy S24 128GB from your cart?", strong: true },
    { type: "radio", label: "Reason", options: ["No longer needed", "Found a better price"] },
    { type: "fields", items: [{ label: "Note", kind: "textarea", placeholder: "Optional note" }] },
    { type: "buttons", items: [{ label: "Remove", primary: true }, { label: "Cancel" }] }
  ]
}

export const SAMPLE_SPECS = { signup: SIGNUP_SPEC, cart: CART_SPEC, inventory: INVENTORY_SPEC, popup: DELETE_POPUP_SPEC } as const
