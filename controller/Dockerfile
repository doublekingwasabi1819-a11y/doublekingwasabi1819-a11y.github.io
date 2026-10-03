# Fixture development/test image. Match this version to package-lock.json.
# A production host must record the resolved image digest before deployment.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /opt/relay-controller
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . ./

# Keep code and browser binaries owned by root; Chromium runs as pwuser.
# Only these fixture output/profile directories are writable by that user.
RUN mkdir -p /home/pwuser/relay-profiles /opt/relay-controller/test-artifacts \
    && chown pwuser:pwuser /home/pwuser/relay-profiles /opt/relay-controller/test-artifacts \
    && chmod 0700 /home/pwuser/relay-profiles /opt/relay-controller/test-artifacts \
    && chmod -R a-w /ms-playwright \
    && node --input-type=module -e "import {accessSync} from 'node:fs'; import {chromium} from 'playwright'; accessSync(chromium.executablePath()); if(Number(process.versions.node.split('.')[0]) < 20) process.exit(1);"

USER pwuser
ENV RELAY_REQUIRE_CHROMIUM=1

# No EXPOSE, background service, public listener, or production activation.
# Operators explicitly choose a test or the authenticated local fixture CLI.
CMD ["node", "--version"]
