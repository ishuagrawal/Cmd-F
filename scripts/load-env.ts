import { config } from 'dotenv';

// Shell values win, then .env.
config({ path: '.env', quiet: true });
