import githubLight from "@shikijs/themes/github-light";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [githubLight],
  langs: [],
});

function hasGrammar(
  language: string,
): language is keyof typeof bundledLanguages {
  return Object.hasOwn(bundledLanguages, language);
}

export async function highlightMessageCode(source: string, language: string) {
  if (!hasGrammar(language)) return undefined;
  await highlighter.loadLanguage(bundledLanguages[language]);
  const { tokens } = highlighter.codeToTokens(source, {
    lang: language,
    theme: githubLight,
  });
  return tokens.flat().filter((token) => token.content.length > 0);
}
