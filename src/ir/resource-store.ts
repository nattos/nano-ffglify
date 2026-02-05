import { ResourceDef, TextureFormat } from './types';

// ------------------------------------------------------------------
// Runtime Values
// ------------------------------------------------------------------
export type ScalarValue = number | boolean | string;
export type VectorValue = number[]; // Supports float2, float3, float4, float3x3, float4x4
export type MatrixValue = number[]; // Alias for clarity
export type ArrayValue = (number | boolean | string | number[] | Record<string, any>)[];

// Recursive structure for structs
export interface StructValue { [key: string]: RuntimeValue };
export type RuntimeValue = ScalarValue | VectorValue | MatrixValue | StructValue | ArrayValue;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

export interface ResourceState {
  def: ResourceDef;
  // In the simulator / host, a "buffer" or "texture" is an array of runtime values
  data?: RuntimeValue[];
  width: number;
  height: number;
  flags?: {
    cpuDirty: boolean; // Data on CPU has changed, needs upload
    gpuDirty: boolean; // Data on GPU has changed, needs download
  };
}

export interface ActionLogEntry {
  type: 'dispatch' | 'draw' | 'resize' | 'log';
  target?: string;
  payload?: any;
}
