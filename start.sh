#!/usr/bin/env bash
OPTION="${1}"

case $OPTION in
    	"start")
            cd /bifrost/
            npm run build
            LD_PRELOAD=./node_modules/node-purple/deps/libpurple/libpurple.so npm start -- --port 3642 -c /data/config.yaml -f /data/bifrost.reg.yaml
            #LD_PRELOAD=/usr/lib/libpurple.so.0 npm start -- --port 9555
            ;;
        "generate")
            cd /bifrost/
            cp /bifrost/config.sample.yaml /data/config.yaml
            #echo "input matrix domain:"
            #read $MATRIX_DOMAIN
            #sed -i  "s/domain: \"localhost\"/domain: \"$MATRIX_DOMAIN\"/g" /data/config.yaml
            npm run genreg -- -u http://localhost:9555 -c /data/config.yaml -f /data/bifrost.reg.yaml # Set listener url here.
            echo "Please review the generated config files in the /data volume"
            ;;
        "test")
            cd /bifrost/
            npm run test
            ;;
        *)
            echo "Unknown \'$OPTION\' available options: start, generate, test"
            ;;
esac
