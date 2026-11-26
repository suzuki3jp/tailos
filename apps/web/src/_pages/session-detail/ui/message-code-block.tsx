import { Fragment, useEffect, useState } from "react";
import type { ThemedToken } from "shiki/types";

export function MessageCodeBlock({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const [highlight, setHighlight] = useState<{
    source: string;
    language: string;
    tokens: ThemedToken[];
  }>();

  useEffect(() => {
    // The initial HTML includes readable code. Grammars load only in the browser.
    if (import.meta.env.SSR) return;
    let current = true;
    void import("./highlight-message-code")
      .then(({ highlightMessageCode }) =>
        highlightMessageCode(source, language),
      )
      .then((tokens) => {
        if (current && tokens) setHighlight({ source, language, tokens });
      })
      .catch(() => {
        // The plain code is already visible if a grammar fails to load or parse.
      });
    return () => {
      current = false;
    };
  }, [source, language]);

  let code = <>{source}</>;
  if (highlight?.source === source && highlight.language === language) {
    let end = 0;
    const spans = highlight.tokens.map((token) => {
      // Copy gaps and line endings from the original source.
      const before = source.slice(end, token.offset);
      end = token.offset + token.content.length;
      return (
        <Fragment key={token.offset}>
          {before}
          <span style={{ color: token.color }}>{token.content}</span>
        </Fragment>
      );
    });
    code = (
      <>
        {spans}
        {source.slice(end)}
      </>
    );
  }
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
