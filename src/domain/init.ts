import { DatabaseState } from "./types";

export const INITIAL_DATABASE_STATE: DatabaseState = {
  ir: {
    version: '1.0.0',
    meta: {
      name: 'New Shader',
    },
    entryPoint: 'fn_main_cpu',
    inputs: [],
    resources: [],
    structs: [],
    functions: [
      {
        id: 'fn_main_cpu',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: []
      }
    ]
  },
  chat_history: [],
  savedInputValues: {},
};
