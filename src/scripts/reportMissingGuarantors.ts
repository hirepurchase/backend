import prisma from '../config/database';

/**
 * READ-ONLY report: customers missing guarantor information, grouped by the
 * admin/agent who created them.
 *
 * Performs no writes. Safe to run against production.
 *
 *   npm run report:missing-guarantors            # agents with gaps, worst first
 *   npm run report:missing-guarantors -- --all   # include fully-compliant creators
 *   npm run report:missing-guarantors -- --list  # also list the affected customers
 *
 * "Missing" = no guarantorName, or no guarantorPhone, or neither. A guarantor
 * you cannot reach is treated as incomplete, so name-without-phone counts.
 */

const SHOW_ALL = process.argv.includes('--all');
const LIST_CUSTOMERS = process.argv.includes('--list');

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim() === '';
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '  0.0%';
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

async function main() {
  const customers = await prisma.customer.findMany({
    select: {
      membershipId: true,
      firstName: true,
      lastName: true,
      phone: true,
      guarantorName: true,
      guarantorPhone: true,
      createdAt: true,
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          isActive: true,
          role: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  type Row = {
    creatorId: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
    total: number;
    missingBoth: number;
    missingNameOnly: number;
    missingPhoneOnly: number;
    complete: number;
    customers: { membershipId: string; name: string; phone: string; missing: string }[];
  };

  const byCreator = new Map<string, Row>();

  let grandTotal = 0;
  let grandMissing = 0;
  let grandMissingBoth = 0;
  let grandNameOnly = 0;
  let grandPhoneOnly = 0;

  for (const c of customers) {
    const creator = c.createdBy;
    const key = creator?.id || '(unknown)';

    if (!byCreator.has(key)) {
      byCreator.set(key, {
        creatorId: key,
        name: creator ? `${creator.firstName} ${creator.lastName}`.trim() : '(unknown creator)',
        email: creator?.email || '—',
        role: creator?.role?.name || '—',
        isActive: creator?.isActive ?? false,
        total: 0,
        missingBoth: 0,
        missingNameOnly: 0,
        missingPhoneOnly: 0,
        complete: 0,
        customers: [],
      });
    }

    const row = byCreator.get(key)!;
    row.total += 1;
    grandTotal += 1;

    const noName = isBlank(c.guarantorName);
    const noPhone = isBlank(c.guarantorPhone);

    let missingLabel: string | null = null;
    if (noName && noPhone) {
      row.missingBoth += 1;
      grandMissingBoth += 1;
      missingLabel = 'name + phone';
    } else if (noName) {
      row.missingNameOnly += 1;
      grandNameOnly += 1;
      missingLabel = 'name';
    } else if (noPhone) {
      row.missingPhoneOnly += 1;
      grandPhoneOnly += 1;
      missingLabel = 'phone';
    } else {
      row.complete += 1;
    }

    if (missingLabel) {
      grandMissing += 1;
      row.customers.push({
        membershipId: c.membershipId,
        name: `${c.firstName} ${c.lastName}`.trim(),
        phone: c.phone,
        missing: missingLabel,
      });
    }
  }

  const rows = Array.from(byCreator.values())
    .filter((r) => SHOW_ALL || r.total - r.complete > 0)
    .sort((a, b) => (b.total - b.complete) - (a.total - a.complete));

  console.log('='.repeat(94));
  console.log('CUSTOMERS MISSING GUARANTOR INFORMATION — BY CREATOR');
  console.log('='.repeat(94));
  console.log('');

  console.log(
    'CREATOR'.padEnd(28) +
    'ROLE'.padEnd(13) +
    'TOTAL'.padStart(6) +
    'MISSING'.padStart(9) +
    '  %MISS' +
    'BOTH'.padStart(6) +
    'NAME'.padStart(6) +
    'PHONE'.padStart(7)
  );
  console.log('-'.repeat(94));

  for (const r of rows) {
    const missing = r.total - r.complete;
    const label = r.name + (r.isActive ? '' : ' [inactive]');
    console.log(
      label.slice(0, 27).padEnd(28) +
      r.role.slice(0, 12).padEnd(13) +
      String(r.total).padStart(6) +
      String(missing).padStart(9) +
      '  ' + pct(missing, r.total) +
      String(r.missingBoth).padStart(6) +
      String(r.missingNameOnly).padStart(6) +
      String(r.missingPhoneOnly).padStart(7)
    );
  }

  console.log('-'.repeat(94));
  console.log(
    'TOTAL'.padEnd(41) +
    String(grandTotal).padStart(6) +
    String(grandMissing).padStart(9) +
    '  ' + pct(grandMissing, grandTotal) +
    String(grandMissingBoth).padStart(6) +
    String(grandNameOnly).padStart(6) +
    String(grandPhoneOnly).padStart(7)
  );
  console.log('');

  console.log('SUMMARY');
  console.log(`  Customers in total                 : ${grandTotal}`);
  console.log(`  With complete guarantor info       : ${grandTotal - grandMissing} (${pct(grandTotal - grandMissing, grandTotal).trim()})`);
  console.log(`  Missing guarantor info             : ${grandMissing} (${pct(grandMissing, grandTotal).trim()})`);
  console.log(`      - missing name AND phone       : ${grandMissingBoth}`);
  console.log(`      - missing name only            : ${grandNameOnly}`);
  console.log(`      - missing phone only           : ${grandPhoneOnly}  <- guarantor recorded but unreachable`);
  console.log(`  Creators with at least one gap     : ${rows.filter((r) => r.total - r.complete > 0).length}`);
  console.log('');

  if (LIST_CUSTOMERS) {
    console.log('='.repeat(94));
    console.log('AFFECTED CUSTOMERS');
    console.log('='.repeat(94));
    for (const r of rows) {
      if (r.customers.length === 0) continue;
      console.log('');
      console.log(`${r.name} (${r.role}) — ${r.customers.length} affected`);
      for (const c of r.customers) {
        console.log(`    ${c.membershipId.padEnd(16)} ${c.name.slice(0, 28).padEnd(30)} ${c.phone.padEnd(13)} missing: ${c.missing}`);
      }
    }
    console.log('');
  } else if (grandMissing > 0) {
    console.log('Re-run with --list to see the affected customers per creator.');
  }

  console.log('Report complete. No data was modified.');
}

main()
  .catch((error) => {
    console.error('Report failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
