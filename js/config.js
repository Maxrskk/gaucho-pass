// Public settings. These two values are safe to publish: the publishable key
// only lets the app talk to Supabase, and Row Level Security plus the server
// functions decide what each signed-in user may do. No secret key belongs here.

export const SUPABASE_URL = 'https://vewlvgzlgcowyambvmep.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_MAwgpshW8ouU5vW-1mGZMQ_Vwz5B5yY';
export const APP_VERSION = '2.0.0';

// Test accounts for the sign-in picker. Emails only; passwords are never in the code.
const DOMAIN = 'gauchopass.example';
export const TEST_ACCOUNTS = [
  { group: 'Students', label: 'Jordan Reyes', email: `jordan@${DOMAIN}` },
  { group: 'Students', label: 'Priya Natarajan', email: `priya@${DOMAIN}` },
  { group: 'Students', label: 'Theo Whitfield (no meal plan)', email: `theo@${DOMAIN}` },
  { group: 'Students', label: 'Lena Park (reported lost)', email: `lena@${DOMAIN}` },
  { group: 'Students', label: 'Sam Okafor', email: `sam@${DOMAIN}` },
  { group: 'Students', label: 'Maya Castellanos (1 swipe left)', email: `maya@${DOMAIN}` },
  { group: 'Students', label: 'Dev Malhotra (no meal plan)', email: `dev@${DOMAIN}` },
  { group: 'Students', label: 'Aiko Tanaka', email: `aiko@${DOMAIN}` },
  { group: 'Staff', label: 'Scanner 1 · Dining Commons Staff', email: `scanner1@${DOMAIN}` },
  { group: 'Staff', label: 'Scanner 2 · Rec Cen Front Desk', email: `scanner2@${DOMAIN}` },
  { group: 'Staff', label: 'Admin · Access Office', email: `admin@${DOMAIN}` },
];
