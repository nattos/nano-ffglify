import { describe, expect } from 'vitest';
import { runGraphTest } from './test-runner';
import { validateIR } from '../../ir/schema';

describe('Compliance: Type Conversion', () => {


  // ----------------------------------------------------------------
  // Float -> Int
  // ----------------------------------------------------------------
  runGraphTest('Cast Float to Int (Truncation)', [
    { id: 'f1', op: 'math_add', a: 1.5, b: 0.1 }, // 1.6
    { id: 'i1', op: 'static_cast_int', val: 'f1' }, // 1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 1);

  runGraphTest('Cast Negative Float to Int (Truncation)', [
    { id: 'f1', op: 'math_add', a: -1.9, b: 0.0 }, // -1.9
    { id: 'i1', op: 'static_cast_int', val: 'f1' }, // -1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', -1);

  // ----------------------------------------------------------------
  // Bool -> Int
  // ----------------------------------------------------------------
  runGraphTest('Cast Bool True to Int', [
    { id: 'b1', op: 'math_gt', a: 10, b: 5 }, // true
    { id: 'i1', op: 'static_cast_int', val: 'b1' }, // 1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 1);

  runGraphTest('Cast Bool False to Int', [
    { id: 'b1', op: 'math_gt', a: 5, b: 10 }, // false
    { id: 'i1', op: 'static_cast_int', val: 'b1' }, // 0
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 0);

  // ----------------------------------------------------------------
  // Int -> Float
  // ----------------------------------------------------------------
  runGraphTest('Cast Int to Float', [
    { id: 'i1', op: 'static_cast_int', val: 5 }, // 5 (from number literal 5 which is float, cast to int first?)
    // Actually literal 5 is number. 'static_cast_int' takes number. Output int.
    // Then we cast back to float.
    { id: 'f1', op: 'static_cast_float', val: 'i1' }, // 5.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 5);

  // ----------------------------------------------------------------
  // Bool -> Float
  // ----------------------------------------------------------------
  runGraphTest('Cast Bool True to Float', [
    { id: 'b1', op: 'math_eq', a: 1, b: 1 }, // true
    { id: 'f1', op: 'static_cast_float', val: 'b1' }, // 1.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 1.0);

  runGraphTest('Cast Bool False to Float', [
    { id: 'b1', op: 'math_eq', a: 1, b: 2 }, // false
    { id: 'f1', op: 'static_cast_float', val: 'b1' }, // 0.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 0.0);

  // ----------------------------------------------------------------
  // Int -> Bool
  // ----------------------------------------------------------------
  runGraphTest('Cast Int Non-Zero to Bool', [
    { id: 'i1', op: 'static_cast_int', val: 5 },
    { id: 'b1', op: 'static_cast_bool', val: 'i1' }, // true
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', true);

  runGraphTest('Cast Int Zero to Bool', [
    { id: 'i1', op: 'static_cast_int', val: 0 },
    { id: 'b1', op: 'static_cast_bool', val: 'i1' }, // false
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', false);

  // ----------------------------------------------------------------
  // Float -> Bool
  // ----------------------------------------------------------------
  runGraphTest('Cast Float Non-Zero to Bool', [
    { id: 'b1', op: 'static_cast_bool', val: 0.1 }, // true
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', true);

  runGraphTest('Cast Float Zero to Bool', [
    { id: 'b1', op: 'static_cast_bool', val: 0.0 }, // false
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', false);

});
