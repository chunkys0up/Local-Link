// Writes the demo GnuCash book: a small repair contractor with three customers, an
// accounts-receivable account and a few months of history, and no invoices yet.
// The demo workflow turns emailed work orders into invoices in it.
//
//   node demo/make-book.mjs [path]   (default: ~/Documents/Local Link Demo/northwind.gnucash)

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const out = process.argv[2] ?? join(homedir(), 'Documents', 'Local Link Demo', 'northwind.gnucash')

// Currencies are written the way GnuCash itself saves them ("CURRENCY", not the older
// "ISO4217"), so a fresh book looks the same before and after GnuCash has saved it.

// Stable GUIDs, so a regenerated book has the same accounts and customers.
const guid = (name) => createHash('md5').update(`retronaut-demo/${name}`).digest('hex')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const USD = '<cmdty:space>CURRENCY</cmdty:space>\n    <cmdty:id>USD</cmdty:id>'

const ACCOUNTS = [
  ['Root Account', 'ROOT', null],
  ['Assets', 'ASSET', 'Root Account'],
  ['Checking Account', 'BANK', 'Assets'],
  ['Accounts Receivable', 'RECEIVABLE', 'Assets'],
  ['Liabilities', 'LIABILITY', 'Root Account'],
  ['Accounts Payable', 'PAYABLE', 'Liabilities'],
  ['Income', 'INCOME', 'Root Account'],
  ['Labor', 'INCOME', 'Income'],
  ['Parts and Materials', 'INCOME', 'Income'],
  ['Expenses', 'EXPENSE', 'Root Account'],
  ['Supplies', 'EXPENSE', 'Expenses'],
  ['Vehicle', 'EXPENSE', 'Expenses'],
  ['Equity', 'EQUITY', 'Root Account'],
  ['Opening Balances', 'EQUITY', 'Equity'],
]

const CUSTOMERS = [
  { id: '000001', name: 'Acme Property Management', addr: ['Acme Property Management', '410 Market St, Suite 200', 'San Francisco, CA 94105'], email: 'ap@acmeproperty.example' },
  { id: '000002', name: 'Brightside Dental Group', addr: ['Brightside Dental Group', '88 Valencia St', 'San Francisco, CA 94103'], email: 'office@brightsidedental.example' },
  { id: '000003', name: 'Harbor View Apartments', addr: ['Harbor View Apartments', '1200 Embarcadero', 'Oakland, CA 94607'], email: 'manager@harborview.example' },
]

// [date, description, [account, cents]...] with debits positive.
const TRANSACTIONS = [
  ['2026-07-01', 'Opening balance', [['Checking Account', 1250000], ['Opening Balances', -1250000]]],
  ['2026-07-14', 'Home Depot #6612', [['Supplies', 48217], ['Checking Account', -48217]]],
  ['2026-08-03', 'Shell Oil', [['Vehicle', 7340], ['Checking Account', -7340]]],
  ['2026-08-21', 'Grainger', [['Supplies', 131900], ['Checking Account', -131900]]],
  ['2026-09-09', 'Shell Oil', [['Vehicle', 6815], ['Checking Account', -6815]]],
  ['2026-10-02', 'Ferguson Plumbing Supply', [['Supplies', 27455], ['Checking Account', -27455]]],
]

const account = ([name, type, parent]) => `<gnc:account version="2.0.0">
  <act:name>${esc(name)}</act:name>
  <act:id type="guid">${guid(`account/${name}`)}</act:id>
  <act:type>${type}</act:type>${
    type === 'ROOT'
      ? ''
      : `
  <act:commodity>
    ${USD}
  </act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:parent type="guid">${guid(`account/${parent}`)}</act:parent>`
  }
</gnc:account>`

const stamp = (date) => `<ts:date>${date} 10:59:00 +0000</ts:date>`

const transaction = ([date, description, splits], i) => `<gnc:transaction version="2.0.0">
  <trn:id type="guid">${guid(`trn/${i}`)}</trn:id>
  <trn:currency>
    ${USD}
  </trn:currency>
  <trn:date-posted>
    ${stamp(date)}
  </trn:date-posted>
  <trn:date-entered>
    ${stamp(date)}
  </trn:date-entered>
  <trn:description>${esc(description)}</trn:description>
  <trn:splits>${splits
    .map(
      ([acct, cents], j) => `
    <trn:split>
      <split:id type="guid">${guid(`trn/${i}/split/${j}`)}</split:id>
      <split:reconciled-state>n</split:reconciled-state>
      <split:value>${cents}/100</split:value>
      <split:quantity>${cents}/100</split:quantity>
      <split:account type="guid">${guid(`account/${acct}`)}</split:account>
    </trn:split>`,
    )
    .join('')}
  </trn:splits>
</gnc:transaction>`

const address = (tag, lines, email) => `<cust:${tag} version="2.0.0">
    <addr:name>${esc(lines[0])}</addr:name>
    <addr:addr1>${esc(lines[1])}</addr:addr1>
    <addr:addr2>${esc(lines[2])}</addr:addr2>${email ? `\n    <addr:email>${esc(email)}</addr:email>` : ''}
  </cust:${tag}>`

const customer = (c) => `<gnc:GncCustomer version="2.0.0">
  <cust:guid type="guid">${guid(`customer/${c.id}`)}</cust:guid>
  <cust:name>${esc(c.name)}</cust:name>
  <cust:id>${c.id}</cust:id>
  ${address('addr', c.addr, c.email)}
  ${address('shipaddr', c.addr)}
  <cust:taxincluded>USEGLOBAL</cust:taxincluded>
  <cust:active>1</cust:active>
  <cust:discount>0/1</cust:discount>
  <cust:credit>0/1</cust:credit>
  <cust:currency>
    ${USD}
  </cust:currency>
  <cust:use-tt>0</cust:use-tt>
</gnc:GncCustomer>`

const NS = ['gnc', 'act', 'book', 'cd', 'cmdty', 'price', 'slot', 'split', 'sx', 'trn', 'ts', 'fs', 'bgt', 'recurrence', 'lot', 'job', 'invoice', 'addr', 'cust', 'billterm', 'bt-days', 'bt-prox', 'taxtable', 'tte', 'order', 'employee', 'entry', 'owner', 'vendor']

const xml = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2
${NS.map((ns) => `     xmlns:${ns}="http://www.gnucash.org/XML/${ns}"`).join('\n')}>
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
<book:id type="guid">${guid('book')}</book:id>
<book:slots>
  <slot>
    <slot:key>counters</slot:key>
    <slot:value type="frame">
      <slot>
        <slot:key>gncCustomer</slot:key>
        <slot:value type="integer">${CUSTOMERS.length}</slot:value>
      </slot>
    </slot:value>
  </slot>
  <slot>
    <slot:key>options</slot:key>
    <slot:value type="frame">
      <slot>
        <slot:key>Business</slot:key>
        <slot:value type="frame">
          <slot>
            <slot:key>Company Name</slot:key>
            <slot:value type="string">Northwind Repair Co.</slot:value>
          </slot>
        </slot:value>
      </slot>
    </slot:value>
  </slot>
</book:slots>
<gnc:count-data cd:type="commodity">1</gnc:count-data>
<gnc:count-data cd:type="account">${ACCOUNTS.length}</gnc:count-data>
<gnc:count-data cd:type="transaction">${TRANSACTIONS.length}</gnc:count-data>
<gnc:count-data cd:type="gnc:GncCustomer">${CUSTOMERS.length}</gnc:count-data>
<gnc:commodity version="2.0.0">
  <cmdty:space>CURRENCY</cmdty:space>
  <cmdty:id>USD</cmdty:id>
  <cmdty:get_quotes/>
  <cmdty:quote_source>currency</cmdty:quote_source>
  <cmdty:quote_tz/>
</gnc:commodity>
${ACCOUNTS.map(account).join('\n')}
${TRANSACTIONS.map(transaction).join('\n')}
${CUSTOMERS.map(customer).join('\n')}
</gnc:book>
</gnc-v2>
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, xml)
console.log(`Wrote ${out}`)
