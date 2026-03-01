import 'server-only';

// Single source of truth lives in route-config.ts (Edge-safe, no 'server-only').
// Server-side code imports from this file to maintain the 'server-only' boundary.
export { isValidReturnTo } from './route-config';
