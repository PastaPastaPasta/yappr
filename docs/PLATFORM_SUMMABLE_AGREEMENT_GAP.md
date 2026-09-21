# A document cannot both echo a bound integer and sum it

**Upstream feature request.** Two independently reasonable rules in rs-dpp are
mutually exclusive in practice: a property bound to another document's integer
by `propertyAgreement` can never carry a `summable` index. The result is that
an application can have **trustworthy per-row numbers** or **proved totals**,
but not both, for any integer sourced from another contract.

Found while cutting Yappr's social contract v9 (docs/SOCIAL_V9.md), where a tip
document cites the token-history `transfer` that paid it.

## The two rules

**1. An agreement pair must match on the exact property type.**
`same_value_kind` in
`rs-drive-abci/src/execution/validation/state_transition/state_transitions/data_contract_common/data_contract_reference_validation/v0/mod.rs`
compares `DocumentPropertyType` discriminants, collapsing only the two
`Identifier` variants:

```rust
fn same_value_kind(a: &DocumentPropertyType, b: &DocumentPropertyType) -> bool {
    let normalized_kind = |property_type: &DocumentPropertyType| match property_type {
        DocumentPropertyType::Identifier | DocumentPropertyType::IdentifierWithReference(_) => {
            std::mem::discriminant(&DocumentPropertyType::Identifier)
        }
        other => std::mem::discriminant(other),
    };
    normalized_kind(a) == normalized_kind(b)
}
```

So a referring property bound to `transfer.amount` must itself infer **U64**:
the token-history contract sets `sized_integer_types` (`rs-dpp/src/system_data_contracts.rs`,
`SystemDataContract::TokenHistory`) and `amount` is `{type: integer, minimum: 0}`,
which `find_integer_type_for_subschema_value` resolves to `U64`.

**2. `summable` rejects U64 outright.**
`rs-dpp/src/data_contract/document_type/class_methods/try_from_schema/common/mod.rs`:

```
summable property "{}" on document type "{}" must be an integer type whose values
fit in i64 (i8..i64 / u8..u32); got U64. U64 is rejected because values above
i64::MAX would overflow grovedb's i64 sum aggregator.
```

Each rule is defensible alone. Together they mean: **the agreement that makes an
amount trustworthy is exactly what forbids aggregating it.**

## Why the ban looks stricter than the runtime needs

The drive-side extractor already handles a U64 summable value gracefully, and
its comment says the DPP layer accepts U64 today —
`rs-drive/src/drive/document/mod.rs`, `read_document_sum_contribution`:

```rust
// `value.to_integer::<i64>()` can fail on a u64 value above i64::MAX. The
// DPP-level cross-validation in `try_from_schema/v2/mod.rs` accepts U64 as a
// summable property type today (changing that would also require restructuring
// property-type inference — tracked follow-up), so this branch is reachable
// from valid input and the error must be user-facing.
value.to_integer::<i64>().map_err(|e| { … DriveError::InvalidInput(…) })
```

The insert path was written expecting U64 summable to be legal. Only the
v3/common cross-validation forbids it.

## Options, preferred first

**A — accept U64 for `summable` when the schema bounds it at or below `i64::MAX`.**
Purely static, no new consensus error, no hot-path cost: an author who wants a
summable positive integer declares `maximum`, and the validator checks it.
The cross-validation currently sees only `flattened_properties` (which carries
the inferred type, not the declared bounds), so this needs the declared maximum
threaded through — the one piece of plumbing the change requires.

**B — accept U64 unconditionally, and validate the value before apply.**
Promote the existing `read_document_sum_contribution` rejection into a consensus
error checked during document state validation, so an out-of-range value rejects
the transition cleanly instead of surfacing as an execution error mid-block.
More faithful to where the invariant really lives (the value, not the type), at
the cost of a new error code and a per-insert comparison.

**C — let integer agreements cross widths** (orthogonal, more general).
Collapse every integer discriminant in `same_value_kind`, and compare integer
agreement pairs numerically rather than through each side's width-dependent
`encode_value_for_tree_keys` (`serialize_value_for_key_v0`). A referring
property narrower than the referenced one then simply cannot hold an
out-of-range value — its own schema validation refuses the document — so the
failure mode is a rejected write, not a silent truncation. This also unblocks
binding to any foreign integer whose width an author cannot choose.

A alone unblocks the Yappr case. C is the one that generalizes.

## Compatibility

All three are **relaxations**: no contract that registers today would stop
registering, and no stored data changes shape. Each needs a protocol version
bump, since a contract accepted under the new rule must be refused by nodes on
the old one.

## What it would buy, concretely

Yappr v9 tips cite their transfer, and consensus binds the writer, the amount
and the payee to it. With the relaxation, `tip` gains
`summable: "amount"` on its `byTipped` and `byRecipient` indexes and the app can
show **"N YAPP received", proved, in O(log n)** — a real lifetime total where
every summand was checked against the payment that produced it. Without it, the
same indexes can only be `countable`, so the honest figure is "N tips", and a
sum over amounts would have to be a page scan (which is the thing v9 exists to
delete).

Related: dashpay/platform#4809, where a sugar-aware prerequisite passed the
offline validator and failed on chain. The same shape applies here — a
cross-contract agreement's kind check cannot be made offline, since the
validator cannot fetch the referenced contract.
