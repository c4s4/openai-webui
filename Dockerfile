FROM nginx:1.27-alpine

ENV NGINX_ENVSUBST_FILTER="^OPENAI_" OPENAI_API_KEY=""
COPY nginx/openai-webui.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 nginx/openai-webui.envsh /docker-entrypoint.d/15-openai-webui.envsh
COPY site/ /var/www/openai-webui/
