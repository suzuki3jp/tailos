export default {
  meta: { name: "tailos-style" },
  rules: {
    "no-nested-ternary": {
      create(context) {
        return {
          ConditionalExpression(node) {
            if (
              node.test.type === "ConditionalExpression" ||
              node.consequent.type === "ConditionalExpression" ||
              node.alternate.type === "ConditionalExpression"
            ) {
              context.report({
                node,
                message:
                  "Nested ternary expressions are not allowed. Extract value selection into a named function with early returns; for finite keys and static values, use a const object mapping checked with satisfies Record<ExpectedKeys, Value>; for case-based logic, use a switch with returning cases. Preserve branch evaluation and type narrowing. Use let with if/else assignments only when these alternatives are inapplicable or excessive; avoid splitting the ternary across temporary variables just to bypass this rule. See lint/no-nested-ternary.md for examples.",
              });
            }
          },
        };
      },
    },
  },
};
