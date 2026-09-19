import { config } from 'dotenv';

// Shell values win, then .env.local, then the checked-in template's .env copy.
config({ path: ['.env.local', '.env'], quiet: true });
