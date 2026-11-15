import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !path.extname(specifier) &&
      context.parentURL?.startsWith("file:")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const baseCandidate = path.resolve(parentDir, specifier);
      const candidates = [
        `${baseCandidate}.ts`,
        `${baseCandidate}.tsx`,
        path.join(baseCandidate, "index.ts"),
        path.join(baseCandidate, "index.tsx"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
