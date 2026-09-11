// Provider credential-field definitions — the trading-clean subset of the
// herobids provider catalog needed for venue-secret validation.
//
// COPY (L3-P1 un-quarantine): the credential field/validation shapes are copied
// verbatim from herobids `apps/api/src/providers/types.ts` +
// `packages/domain/src/provider-catalog.ts`. Only the PLATFORM catalog
// projection surface (the public `ProviderCatalogResponse`, wallet-generation
// capability, ETag response envelope) is DELETED — it is not a trading concern
// and its `@herobids/domain` catalog types were never brought into
// `@traderton/domain`. The credential field definitions + validation shapes ARE
// trading behaviour and are preserved intact.

/** A field's normalisation rules applied before validation + persistence. */
export type NormalizationRule = 'trim' | 'lowercase' | 'uppercase';

export interface FieldValidation {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface FieldDefinition {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  inputKind: 'text' | 'password' | 'textarea' | 'number';
  aliases: string[];
  validation?: FieldValidation;
}

export interface ValidationErrorDefinition {
  code: string;
  message: string;
}

export interface RegistryFieldDefinition extends FieldDefinition {
  normalization?: NormalizationRule[];
  errors?: {
    required?: ValidationErrorDefinition;
    pattern?: ValidationErrorDefinition;
    minLength?: ValidationErrorDefinition;
    maxLength?: ValidationErrorDefinition;
  };
}

export interface RegistryCredentialSchema {
  description?: string;
  fields: RegistryFieldDefinition[];
}

export interface RegistryConnectionSchema {
  description?: string;
  requiresCredential: boolean;
  allowsCredential: boolean;
  credentialProviderIds: string[];
  autoCreatesTradingConnection: boolean;
}

export interface RegistryEntry {
  id: string;
  displayName: string;
  status: 'supported' | 'deprecated';
  categories: string[];
  logoUrl?: string;
  credentials?: RegistryCredentialSchema;
  connections?: RegistryConnectionSchema;
}
