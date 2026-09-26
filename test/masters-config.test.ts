import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLedgers, fetchOutstandings, fetchStockItems } from "../src/excer/masters.js";
import { loadAgentConfig, postsAsOptional } from "../src/excer/config.js";
import { agentConfig, collection, collectionId, fakeClient } from "./helpers.js";

test("stock item names come through exactly — '007' is not turned into 7", async () => {
  const { client } = fakeClient(() =>
    collection(
      `<STOCKITEM><GUID>g-1</GUID><NAME>007</NAME><ALTERID>3</ALTERID>` +
        `<CLOSINGBALANCE>1,234.50 Nos</CLOSINGBALANCE><GSTRATE>18</GSTRATE></STOCKITEM>`
    )
  );
  const [item] = await fetchStockItems(client, 0, "Test Co");
  assert.equal(item.name, "007");
  assert.equal(item.closingStockQty, 1234.5);
  assert.equal(item.alterId, 3);
  assert.equal(item.gstRate, 18);
});

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("config: a weak or placeholder API key is refused at startup", () => {
  withEnv({ AGENT_API_KEY: "change-me" }, () => assert.throws(loadAgentConfig, /too weak/));
  withEnv({ AGENT_API_KEY: "short" }, () => assert.throws(loadAgentConfig, /too weak/));
  withEnv({ AGENT_API_KEY: "a-long-enough-random-secret" }, () => assert.doesNotThrow(loadAgentConfig));
});

test("config: trailing slashes are stripped from the app URL", () => {
  withEnv({ AGENT_API_KEY: "a-long-enough-random-secret", EXCER_APP_URL: "https://app.example.com//" }, () =>
    assert.equal(loadAgentConfig().appBaseUrl, "https://app.example.com")
  );
});

test("typed values from a targeted FETCH are unwrapped (real TallyPrime shape)", async () => {
  // <GUID TYPE="String">…</GUID> etc. — previously these became JSON strings and AlterID 0.
  const { client } = fakeClient(() =>
    collection(
      `<STOCKITEM NAME="Copper Cable 2.5mm"><GUID TYPE="String">abc-000000d7</GUID>` +
        `<ALTERID TYPE="Number"> 217</ALTERID><BASEUNITS TYPE="String">Mtr</BASEUNITS>` +
        `<CLOSINGBALANCE TYPE="Quantity"> 500.00 Mtr</CLOSINGBALANCE></STOCKITEM>`
    )
  );
  const [item] = await fetchStockItems(client, 0, "Test Co");
  assert.deepEqual([item.guid, item.alterId, item.baseUnit, item.closingStockQty], ["abc-000000d7", 217, "Mtr", 500]);
});

test("ledger state/GSTIN/address come from TallyPrime's dated lists, latest entry wins", async () => {
  const { client } = fakeClient(() =>
    collection(
      `<LEDGER NAME="Probe Ledger"><GUID TYPE="String">g-da</GUID><ALTERID TYPE="Number"> 224</ALTERID>` +
        `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20200401</APPLICABLEFROM><GSTIN>33OLD</GSTIN></LEDGSTREGDETAILS.LIST>` +
        `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><GSTIN>33AABCC1234D1Z9</GSTIN></LEDGSTREGDETAILS.LIST>` +
        `<LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>12 Anna Salai</ADDRESS><ADDRESS>Chennai</ADDRESS></ADDRESS.LIST>` +
        `<APPLICABLEFROM>20260401</APPLICABLEFROM><PINCODE>600002</PINCODE><STATE>Tamil Nadu</STATE></LEDMAILINGDETAILS.LIST></LEDGER>`
    )
  );
  const [row] = await fetchLedgers(client, 0, "Test Co");
  assert.equal(row.ledgerName, "Probe Ledger");
  assert.equal(row.gstin, "33AABCC1234D1Z9");
  assert.equal(row.state, "Tamil Nadu");
  assert.equal(row.addressLine, "12 Anna Salai, Chennai");
  assert.equal(row.pincode, "600002");
});

test("stock item GST rate/HSN come from TallyPrime's dated GSTDETAILS/HSNDETAILS lists", async () => {
  // Verbatim structure read back from a live TallyPrime Edit Log, 2026-09-24.
  const gst = (rates: string) =>
    `<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY>` +
    `<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>${rates}</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
  const rate = (head: string, r: string) =>
    `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD><GSTRATE> ${r}</GSTRATE></RATEDETAILS.LIST>`;
  const { client } = fakeClient(() =>
    collection(
      `<STOCKITEM NAME="A">${gst(rate("CGST", "9") + rate("SGST/UTGST", "9") + rate("IGST", "18"))}` +
        `<HSNDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>85444999</HSNCODE></HSNDETAILS.LIST></STOCKITEM>` +
        `<STOCKITEM NAME="B">${gst(rate("CGST", "6") + rate("SGST/UTGST", "6"))}</STOCKITEM>` +
        `<STOCKITEM NAME="C"><GSTRATE TYPE="Number"></GSTRATE></STOCKITEM>` +
        `<STOCKITEM NAME="D"><GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><TAXABILITY>Exempt</TAXABILITY></GSTDETAILS.LIST></STOCKITEM>`
    )
  );
  const items = await fetchStockItems(client, 0, "Test Co");
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName.A.gstRate, 18);
  assert.equal(byName.A.hsnCode, "85444999");
  assert.equal(byName.B.gstRate, 12); // CGST + SGST when no IGST row
  assert.equal(byName.C.gstRate, null); // unknown, NOT 0 — 0 would post the sale tax-free
  assert.equal(byName.D.gstRate, 0); // genuinely exempt
});

test("base price is the SET standard selling price — never cost, never the last sale's rate", async () => {
  // Verbatim live TallyPrime shapes: an item with a price list, and one without (whose computed
  // $StandardPrice fell back to the last sale's 350 and whose OpeningRate is cost).
  const { client } = fakeClient(() =>
    collection(
      `<STOCKITEM NAME="Priced"><OPENINGRATE TYPE="Rate">45.00/Mtr</OPENINGRATE>` +
        `<STANDARDPRICELIST.LIST><DATE>20250401</DATE><RATE>55.00/Mtr</RATE></STANDARDPRICELIST.LIST>` +
        `<STANDARDPRICELIST.LIST><DATE>20260401</DATE><RATE>60.00/Mtr</RATE></STANDARDPRICELIST.LIST></STOCKITEM>` +
        `<STOCKITEM NAME="Unpriced"><OPENINGRATE TYPE="Rate">250.00/Nos</OPENINGRATE>` +
        `<STANDARDPRICE TYPE="Rate">350.00/Nos</STANDARDPRICE><STANDARDPRICELIST.LIST> </STANDARDPRICELIST.LIST></STOCKITEM>`
    )
  );
  const items = await fetchStockItems(client, 0, "Test Co");
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName.Priced.baseRate, 60); // latest dated entry
  assert.equal(byName.Unpriced.baseRate, null);
});

test("line breaks Tally keeps in names and addresses are decoded and tidied (live TallyPrime)", async () => {
  const { client } = fakeClient((xml) =>
    xml.includes("StockItem")
      ? collection(
          `<STOCKITEM NAME="Twisted Wire Aluminum - 40 X 76 - Drum&#13;&#10;&#13;&#10;">` +
            `<GUID TYPE="String">g-cr</GUID><ALTERID TYPE="Number"> 5</ALTERID></STOCKITEM>`
        )
      : collection(
          `<LEDGER NAME="A &amp; B Traders"><GUID TYPE="String">g-l</GUID><ALTERID TYPE="Number"> 6</ALTERID>` +
            `<LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>SBM 10/110, Kavungal Building, &#10;Near Pipe House</ADDRESS></ADDRESS.LIST>` +
            `<APPLICABLEFROM>20260401</APPLICABLEFROM><STATE>Kerala</STATE></LEDMAILINGDETAILS.LIST></LEDGER>`
        )
  );
  const [item] = await fetchStockItems(client, 0, "Test Co");
  assert.equal(item.name, "Twisted Wire Aluminum - 40 X 76 - Drum");
  const [row] = await fetchLedgers(client, 0, "Test Co");
  assert.equal(row.ledgerName, "A & B Traders");
  assert.equal(row.addressLine, "SBM 10/110, Kavungal Building, Near Pipe House");
});

test("a large export with thousands of escaped characters still parses (live company tripped the cap)", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) =>
    `<STOCKITEM NAME="Item ${i} &amp; Co&#13;&#10;"><GUID TYPE="String">g-${i}</GUID><ALTERID TYPE="Number"> ${i + 1}</ALTERID></STOCKITEM>`
  ).join("");
  const { client } = fakeClient(() => collection(rows));
  const items = await fetchStockItems(client, 0, "Test Co");
  assert.equal(items.length, 1200);
  assert.equal(items[1199].name, "Item 1199 & Co");
});

test("each stock item carries its stock-group path, top level first, without Tally's root", async () => {
  const { client } = fakeClient((xml) =>
    collectionId(xml) === "ExcerStockGroups"
      ? collection(
          // Shapes from the client's live company: the root arrives as "&#4; Primary".
          `<STOCKGROUP NAME="Cable"><PARENT TYPE="String">&#4; Primary</PARENT></STOCKGROUP>` +
            `<STOCKGROUP NAME="AC Cable"><PARENT TYPE="String">Cable</PARENT></STOCKGROUP>` +
            `<STOCKGROUP NAME="Solar Accessories"><PARENT TYPE="String">&#4; Primary</PARENT></STOCKGROUP>`
        )
      : collection(
          `<STOCKITEM NAME="4 Sqmm AC"><GUID>g-1</GUID><PARENT TYPE="String">AC Cable</PARENT></STOCKITEM>` +
            `<STOCKITEM NAME="MC4 Connector"><GUID>g-2</GUID><PARENT TYPE="String">Solar Accessories</PARENT></STOCKITEM>` +
            `<STOCKITEM NAME="Loose Item"><GUID>g-3</GUID><PARENT TYPE="String">&#4; Primary</PARENT></STOCKITEM>`
        )
  );
  const items = await fetchStockItems(client, 0, "Test Co");
  assert.deepEqual(
    items.map((i) => i.stockGroupPath),
    [["Cable", "AC Cable"], ["Solar Accessories"], []]
  );
});

test("closing rate and value come through as Tally's Stock Summary shows them", async () => {
  const { client } = fakeClient((xml) =>
    collectionId(xml) === "ExcerStockGroups"
      ? collection("")
      : collection(
          // Live shapes: the value is a debit, so Tally sends it negative.
          `<STOCKITEM NAME="Tubular Terminal End 10 Sq.mm Copper"><GUID>g-1</GUID>` +
            `<CLOSINGBALANCE TYPE="Quantity"> 7208 Pcs</CLOSINGBALANCE>` +
            `<CLOSINGVALUE TYPE="Amount">-52082.99</CLOSINGVALUE>` +
            `<CLOSINGRATE TYPE="Rate">7.23/Pcs</CLOSINGRATE></STOCKITEM>` +
            `<STOCKITEM NAME="No Stock"><GUID>g-2</GUID><CLOSINGVALUE TYPE="Amount"></CLOSINGVALUE></STOCKITEM>`
        )
  );
  const [item, empty] = await fetchStockItems(client, 0, "Test Co");
  assert.equal(item.closingRate, 7.23);
  assert.equal(item.closingValue, 52082.99);
  assert.equal(empty.closingRate, null);
  assert.equal(empty.closingValue, null);
});

test("outstandings: Dr reads positive, Cr negative, zero balances left out (live shapes)", async () => {
  const { client, requests } = fakeClient(() =>
    collection(
      `<LEDGER NAME="3 Dot Power Solutions"><GUID TYPE="String">g-1</GUID><PARENT TYPE="String">Solar - Rasmy</PARENT>` +
        `<CLOSINGBALANCE TYPE="Amount">-19812.00</CLOSINGBALANCE></LEDGER>` +
        `<LEDGER NAME="Advance Party"><GUID TYPE="String">g-2</GUID><PARENT TYPE="String">Sundry Debtors</PARENT>` +
        `<CLOSINGBALANCE TYPE="Amount">5000.00</CLOSINGBALANCE></LEDGER>` +
        `<LEDGER NAME="Settled"><GUID TYPE="String">g-3</GUID><CLOSINGBALANCE TYPE="Amount"></CLOSINGBALANCE></LEDGER>`
    )
  );
  const rows = await fetchOutstandings(client, "Test Co");
  assert.deepEqual(rows, [
    { guid: "g-1", name: "3 Dot Power Solutions", group: "Solar - Rasmy", balance: 19812 },
    { guid: "g-2", name: "Advance Party", group: "Sundry Debtors", balance: -5000 },
  ]);
  // Sub-group parties are included: the filter is $$IsBelongsTo, not $Parent =.
  assert.match(requests[0], /\$\$IsBelongsTo:"Sundry Debtors"/);
});

test("config: Delivery Notes post Regular (they move Tally's stock); other vouchers stay Optional", () => {
  withEnv({ AGENT_API_KEY: "a-long-enough-random-secret" }, () => {
    const config = loadAgentConfig();
    assert.equal(postsAsOptional("push_delivery_note", config), false);
    assert.equal(postsAsOptional("push_sales_order", config), true);
    assert.equal(postsAsOptional("push_credit_note", config), true);
  });
  const allOptional = agentConfig({ postDeliveryNotesAsOptional: true });
  assert.equal(postsAsOptional("push_delivery_note", allOptional), true);
});
