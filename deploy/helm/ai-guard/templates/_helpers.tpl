{{- define "ai-guard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-guard.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "ai-guard.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ai-guard.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "ai-guard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ai-guard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-guard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /* Secret holding API key, DB URL, LiteLLM key, provider keys. */ -}}
{{- define "ai-guard.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "ai-guard.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "ai-guard.configMapName" -}}
{{- if .Values.config.existingConfigMap -}}
{{- .Values.config.existingConfigMap -}}
{{- else -}}
{{- printf "%s-config" (include "ai-guard.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- /* Effective LiteLLM base URL (in-cluster service or external override). */ -}}
{{- define "ai-guard.litellmUrl" -}}
{{- if .Values.litellm.enabled -}}
{{- printf "http://%s-litellm:4000" (include "ai-guard.fullname" .) -}}
{{- else -}}
{{- .Values.litellm.baseUrl -}}
{{- end -}}
{{- end -}}

{{- define "ai-guard.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- printf "redis://%s-redis:6379" (include "ai-guard.fullname" .) -}}
{{- else -}}
{{- .Values.redis.url -}}
{{- end -}}
{{- end -}}

{{- /*
  Fail the render if `production` is true and an image uses a floating tag
  (latest / main / main-stable / stable / master / edge / nightly, or no tag).
  Digest-pinned (`@sha256:`) and version-tagged images pass. Call with:
    {{ include "ai-guard.assertPinnedImage" (dict "ctx" . "image" <image> "field" "<name>") }}
*/ -}}
{{- define "ai-guard.assertPinnedImage" -}}
{{- if .ctx.Values.production -}}
{{- $image := .image -}}
{{- $tag := "" -}}
{{- if contains "@sha256:" $image -}}
{{- $tag = "sha256-digest" -}}
{{- else if contains ":" $image -}}
{{- $tag = last (splitList ":" $image) -}}
{{- else -}}
{{- $tag = "latest" -}}
{{- end -}}
{{- $floating := list "latest" "main" "main-stable" "stable" "master" "edge" "nightly" -}}
{{- if has $tag $floating -}}
{{- fail (printf "production=true but %s image %q uses a floating tag %q. Pin a version or @sha256 digest (see the chart README)." .field $image $tag) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* ServiceAccount name for the API (created by the chart or supplied). */ -}}
{{- define "ai-guard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ai-guard.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
