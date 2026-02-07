import { BaseEntity, IRDocument, ValidationError } from '../domain/types';

// Standard Response Wrapper
export interface EntityResponse {
  success: boolean;
  message: string;
  data?: any;
  errors?: ValidationError[];
}

// Accpet the given IRDocument as is.
export type ReplaceIRRequest = IRDocument;

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string; // e.g. "/relations" or "/relations/-" (append)
  value?: any;
}

export type PatchIRRequest = {
  patches: PatchOperation[]
}

// Side Effect / Result Inspection
// When an Upsert happens, we might want to know what else changed.
// e.g. Upserting a generic "Pizza" Event might trigger a "Research Needed" side effect.
export interface MutationResult {
  entity_id: string;
  operation: 'created' | 'updated';

  // Did this trigger a research need?
  research_required?: {
    query: string;
    context: string;
  };

  // Did this auto-update other entities?
  side_effects?: {
    entity_type: string;
    entity_id: string;
    operation: string;
  }[];
}
