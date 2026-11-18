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
                  "Nested ternary expressions are not allowed. Use an object mapping for discrete values, or extract the condition into a variable or an if statement.",
              });
            }
          },
        };
      },
    },
  },
};
