import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://mjefrcrtdqhwqowstnyn.supabase.co';
const supabaseAnonKey = 'sb_publishable_i9k95UMsJfLjdrpbR7flvA_BNxoVsCU';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);