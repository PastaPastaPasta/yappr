/** Positive schema evidence for Pollr's two choices-array probes, including AJV client validation. */
function choicesSchemaRefusal(consensusMessage, clientMessage) {
  return new RegExp(
    String.raw`^(?=[\s\S]*(?:\bJsonSchemaError\b|\bcode["']?\s*[=:]\s*10101\b))(?=[\s\S]*\/choices\b)(?=[\s\S]*${consensusMessage})`
    + String.raw`|(?:data(?:\/|\.)|\/)choices\s+(?:must|should)\s+${clientMessage}`,
    'i',
  );
}

export const CHOICES_MIN_ITEMS = choicesSchemaRefusal(
  'has less than 1 items?', '(?:NOT have fewer than 1|have at least 1) items?',
);
export const CHOICES_UNIQUE_ITEMS = choicesSchemaRefusal(
  'has non-unique elements', 'NOT have duplicate items',
);
