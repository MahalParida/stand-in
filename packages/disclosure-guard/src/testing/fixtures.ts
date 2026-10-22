import type { FactInput } from '../types.js';

// All values are synthetic test data. Card numbers are well-known test PANs.
export const FACTS: FactInput[] = [
  { key: 'name', label: 'Account holder name', value: 'Asha Rao', tier: 'share', approved: false },
  { key: 'order_id', label: 'Order ID', value: 'OD12345', tier: 'share', approved: false },
  { key: 'reg_phone', label: 'Registered phone', value: '98765 00000', tier: 'confirm', approved: false },
  { key: 'email', label: 'Email', value: 'asha@example.com', tier: 'confirm', approved: true },
  { key: 'otp', label: 'OTP', value: '482911', tier: 'never', approved: false },
  { key: 'pin', label: 'ATM PIN', value: '4219', tier: 'never', approved: false },
  { key: 'password', label: 'Portal password', value: 'Sunflower@99', tier: 'never', approved: true },
  { key: 'card', label: 'Card number', value: '4111 1111 1111 1111', tier: 'never', approved: false },
  { key: 'aadhaar', label: 'Aadhaar', value: '2345-6789-0123', tier: 'never', approved: false },
];
