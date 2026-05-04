import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '../../../lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  if (supabase) {
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL('/', request.url));
}
