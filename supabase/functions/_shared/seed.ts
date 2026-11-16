// Demo data. Every person here is made up: no real names, perm numbers or photos.
// "Reset demo data" puts the database back to exactly this state.

export const EMAIL_DOMAIN = 'gauchopass.example';

export const LOCATIONS = [
  { id: 'carrillo', name: 'Carrillo Dining Commons', short_name: 'Carrillo', type: 'dining', sort: 1 },
  { id: 'dlg', name: 'De La Guerra Dining Commons', short_name: 'De La Guerra', type: 'dining', sort: 2 },
  { id: 'rec', name: 'Recreation Center', short_name: 'Rec Cen', type: 'rec', sort: 3 },
  { id: 'bus', name: 'MTD Bus · Line 11', short_name: 'MTD bus', type: 'bus', sort: 4 },
  { id: 'lib', name: 'UCSB Library', short_name: 'Library', type: 'library', sort: 5 },
];

const ALL = ['dining', 'rec', 'bus', 'library'];
const NO_DINING = ['rec', 'bus', 'library'];

export type SeedStudent = {
  perm: string;
  first_name: string;
  last_name: string;
  year: string;
  major: string;
  avatar: string;
  status: 'active' | 'lost';
  access: string[];
  meal_plan: string | null;
  swipes_per_week: number | null;
  swipes_left: number | null;
};

export type SeedAccount = {
  email: string;
  role: 'student' | 'scanner' | 'admin';
  display_name: string;
  student: SeedStudent | null;
};

function student(
  perm: string, first: string, last: string, year: string, major: string,
  meal: [string, number | null, number | null] | null,
  extra: Partial<SeedStudent> = {},
): SeedAccount {
  return {
    email: `${first.toLowerCase()}@${EMAIL_DOMAIN}`,
    role: 'student',
    display_name: `${first} ${last}`,
    student: {
      perm, first_name: first, last_name: last, year, major,
      avatar: first.toLowerCase(),
      status: 'active',
      access: meal ? ALL : NO_DINING,
      meal_plan: meal ? meal[0] : null,
      swipes_per_week: meal ? meal[1] : null,
      swipes_left: meal ? meal[2] : null,
      ...extra,
    },
  };
}

function staff(name: string, role: 'scanner' | 'admin', display: string): SeedAccount {
  return { email: `${name}@${EMAIL_DOMAIN}`, role, display_name: display, student: null };
}

export const ACCOUNTS: SeedAccount[] = [
  student('9900142', 'Jordan', 'Reyes', 'Second year', 'Mechanical Engineering', ['14 meals a week', 14, 9]),
  student('9900287', 'Priya', 'Natarajan', 'First year', 'Biology', ['Unlimited meals', null, null]),
  student('9900355', 'Theo', 'Whitfield', 'Fourth year', 'Economics', null),
  student('9900419', 'Lena', 'Park', 'Third year', 'Psychology', ['10 meals a week', 10, 6], { status: 'lost' }),
  student('9900503', 'Sam', 'Okafor', 'First year', 'Computer Science', ['14 meals a week', 14, 11]),
  student('9900618', 'Maya', 'Castellanos', 'Third year', 'Environmental Studies', ['10 meals a week', 10, 1]),
  student('9900734', 'Dev', 'Malhotra', 'Graduate student', 'Materials', null),
  student('9900851', 'Aiko', 'Tanaka', 'Second year', 'Film and Media Studies', ['14 meals a week', 14, 14]),
  staff('scanner1', 'scanner', 'Dining Commons Staff'),
  staff('scanner2', 'scanner', 'Rec Cen Front Desk'),
  staff('admin', 'admin', 'Access Office Admin'),
];

/** Fixed test students for the one-tap demo scenarios. */
export const SCENARIO_PERMS = {
  live: '9900142', // Jordan
  expired: '9900142',
  reuse: '9900503', // Sam
  forged: '9900287', // Priya
  lost: '9900419', // Lena, seeded as reported lost
  mealplan: '9900355', // Theo, no meal plan
  no_swipes: '9900618', // Maya, one swipe left
  guest_reuse: '9900142',
  guest_expired: '9900142',
} as const;

export type Scenario = keyof typeof SCENARIO_PERMS;

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCENARIO_PERMS, value);
}
