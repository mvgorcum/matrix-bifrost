FROM node:10-stretch-slim

COPY . /bifrost

ENTRYPOINT ["/bifrost/start.sh"]
#CMD ["start"]
EXPOSE 9555 3642
VOLUME ["/data"]
COPY . /bifrost

RUN apt-get update && apt-get install -y build-essential libuv1 \
    && cd /bifrost ;\
    npm install \
    && npm run build
