import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, grammar] of Object.entries({ bash, css, diff, go, javascript, json, python, rust, sql, typescript, xml, yaml })) {
	hljs.registerLanguage(name, grammar);
}
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["tsx"], { languageName: "typescript" });

/** Only a declared, bundled grammar. Never auto-detect or inject model-authored HTML. */
export function highlight(source: string, language: string): string | undefined {
	if (!hljs.getLanguage(language)) return;
	try {
		return hljs.highlight(source, { language, ignoreIllegals: true }).value;
	} catch {
		return;
	}
}
