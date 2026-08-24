FROM python:3.12-alpine

COPY ./docker/control/server.py /usr/local/bin/nestbox-control
COPY ./docker/control/host_bridge.py /usr/local/bin/nestbox-host-bridge

RUN python -m py_compile /usr/local/bin/nestbox-control /usr/local/bin/nestbox-host-bridge && \
    chmod 0755 /usr/local/bin/nestbox-control /usr/local/bin/nestbox-host-bridge

WORKDIR /workspace

EXPOSE 4088

CMD ["/usr/local/bin/nestbox-control"]
