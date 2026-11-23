export const Roles = ['SUPER_ADMIN', 'ZONAL_FRANCHISE', 'REMOTE_FRANCHISE', 'MEMBER', 'CUSTOMER'] as const;
export type Role = (typeof Roles)[number];

export const UserStatuses = ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type UserStatus = (typeof UserStatuses)[number];

export const KycStatuses = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type KycStatus = (typeof KycStatuses)[number];

export const FranchiseTypes = ['ZONAL', 'REMOTE'] as const;
export type FranchiseType = (typeof FranchiseTypes)[number];

export const Ranks = ['ASSOCIATE', 'SILVER', 'GOLD', 'DIAMOND'] as const;
export type Rank = (typeof Ranks)[number];

export const OrderStatuses = ['PLACED', 'PAID', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export type OrderStatus = (typeof OrderStatuses)[number];

export const CommissionStatuses = ['PENDING', 'APPROVED', 'REVERSED'] as const;
export type CommissionStatus = (typeof CommissionStatuses)[number];

export const WalletEntryTypes = [
  'COMMISSION_CREDIT', 'COMMISSION_REVERSAL', 'FRANCHISE_CREDIT', 'CASHBACK_CREDIT', 'CASHBACK_REVERSAL',
  'WITHDRAWAL_DEBIT', 'WITHDRAWAL_REFUND', 'ADJUSTMENT',
  'TRANSFER_OUT', 'TRANSFER_IN', 'SHOPPING_SPEND', 'SHOPPING_REFUND', 'P2P_OUT', 'P2P_IN', 'DEPOSIT',
] as const;
export type WalletEntryType = (typeof WalletEntryTypes)[number];

export const WithdrawalStatuses = ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'] as const;
export type WithdrawalStatus = (typeof WithdrawalStatuses)[number];

export const ShipmentStatuses = ['PENDING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED'] as const;
export type ShipmentStatus = (typeof ShipmentStatuses)[number];

export const AddressLabels = ['HOME', 'OFFICE', 'OTHER'] as const;
export type AddressLabel = (typeof AddressLabels)[number];

export const WalletTypes = ['INCOME', 'SHOPPING'] as const;
export type WalletType = (typeof WalletTypes)[number];

export const FundRequestStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type FundRequestStatus = (typeof FundRequestStatuses)[number];

export const PaymentModes = ['UPI', 'IMPS', 'NEFT', 'RTGS', 'CASH_DEPOSIT'] as const;
export type PaymentMode = (typeof PaymentModes)[number];
