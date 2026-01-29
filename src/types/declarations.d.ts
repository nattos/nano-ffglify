declare module '@google/generative-ai' {
  export class GoogleGenerativeAI {
    constructor(apiKey: string);
    getGenerativeModel(args: any): any;
  }
  export enum SchemaType {
    STRING = "STRING",
    NUMBER = "NUMBER",
    INTEGER = "INTEGER",
    BOOLEAN = "BOOLEAN",
    ARRAY = "ARRAY",
    OBJECT = "OBJECT"
  }
  export interface FunctionDeclaration {
    name: string;
    description: string;
    parameters?: any;
  }
}

declare module 'idb' {
  export interface DBSchema {
    [storeName: string]: {
      key: any;
      value: any;
      indexes?: Record<string, any>;
    };
  }
  export interface IDBPDatabase<Schema extends DBSchema> {
    objectStoreNames: DOMStringList;
    createObjectStore(name: string, options?: any): any;
    put(storeName: string, value: any, key?: any): Promise<any>;
    get(storeName: string, key: any): Promise<any>;
  }
  export function openDB<Schema extends DBSchema>(name: string, version: number, options?: { upgrade?: (db: IDBPDatabase<Schema>) => void }): Promise<IDBPDatabase<Schema>>;
}
