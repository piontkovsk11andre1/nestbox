FROM node:alpine

# Resolve latest at build time, with no startup install or host npm process.
RUN npm install --prefix /opt/do-md --engine-strict --omit=dev --no-audit --no-fund @p10i/do-md@latest && \
    ln -s /opt/do-md/node_modules/.bin/do-md /usr/local/bin/do-md && \
    ln -s /opt/do-md/node_modules/.bin/do-md-mcp /usr/local/bin/do-md-mcp

USER node
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["do-md"]
CMD ["serve", "--root", "/workspace", "--host", "0.0.0.0", "--port", "8080", "--timeout-ms", "20000"]
