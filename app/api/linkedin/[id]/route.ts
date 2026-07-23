import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonOk, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { linkedinCompanies } from '../../../../lib/db/schema';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await params;
    const removed = await db()
      .delete(linkedinCompanies)
      .where(and(eq(linkedinCompanies.id, id), eq(linkedinCompanies.userId, user.id)))
      .returning({ id: linkedinCompanies.id });
    if (removed.length === 0) return jsonError('not found', 404);
    return jsonOk({ removed: id });
  }, req);
}
