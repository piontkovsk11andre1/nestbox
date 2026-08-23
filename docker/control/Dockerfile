FROM python:3.12-alpine

COPY ./docker/control/server.py /usr/local/bin/nestbox-control

RUN python -m py_compile /usr/local/bin/nestbox-control && \
    chmod 0755 /usr/local/bin/nestbox-control

WORKDIR /workspace

EXPOSE 4088

CMD ["/usr/local/bin/nestbox-control"]
