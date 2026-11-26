import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { MessageCodeBlock } from "./message-code-block";
import styles from "./message-markdown.module.css";

function httpUrl(url: string) {
  if (/^https?:\/\//i.test(url) && URL.canParse(url)) return url;
  return undefined;
}

const pre: NonNullable<Components["pre"]> = ({ children, node }) => {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code")
    return <pre>{children}</pre>;

  const text = code.children[0];
  const classes = code.properties.className;
  const languageClass = Array.isArray(classes)
    ? classes.find(
        (name): name is string =>
          typeof name === "string" && name.startsWith("language-"),
      )
    : undefined;
  if (!languageClass || text?.type !== "text") return <pre>{children}</pre>;

  return (
    <MessageCodeBlock
      source={text.value}
      language={languageClass.slice("language-".length).toLowerCase()}
    />
  );
};

const conversationComponents: Components = {
  h1: "h2",
  h2: "h3",
  h3: "h4",
  h4: "h5",
  h5: "h6",
  a: ({ children, href, title }) =>
    href ? (
      <a href={href} title={title}>
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => alt ?? "",
  ul: ({ children }) => <ul role="list">{children}</ul>,
  pre,
};

const sectionComponents: Components = {
  ...conversationComponents,
  h1: "h3",
  h2: "h4",
  h3: "h5",
  h4: "h6",
};

export const MessageMarkdown = memo(function MessageMarkdown({
  body,
  bubble = false,
  withinSection = false,
}: {
  body: string;
  bubble?: boolean;
  withinSection?: boolean;
}) {
  return (
    <div className={styles.markdown} data-bubble={bubble || undefined}>
      <Markdown
        components={withinSection ? sectionComponents : conversationComponents}
        remarkPlugins={[remarkBreaks]}
        urlTransform={httpUrl}
      >
        {body}
      </Markdown>
    </div>
  );
});
