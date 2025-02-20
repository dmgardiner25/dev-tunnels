// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
    Tunnel,
    TunnelConnectionMode,
    TunnelAccessControl,
    TunnelAccessScopes,
    TunnelEndpoint,
    TunnelPort,
    ProblemDetails,
    TunnelServiceProperties,
    ClusterDetails,
    NamedRateStatus,
} from '@microsoft/dev-tunnels-contracts';
import {
    ProductHeaderValue,
    TunnelAuthenticationSchemes,
    TunnelManagementClient,
} from './tunnelManagementClient';
import { TunnelRequestOptions } from './tunnelRequestOptions';
import { TunnelAccessTokenProperties } from './tunnelAccessTokenProperties';
import { tunnelSdkUserAgent } from './version';
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse, Method } from 'axios';
import * as https from 'https';

type NullableIfNotBoolean<T> = T extends boolean ? T : T | null;

const apiV1Path = `/api/v1`;
const tunnelsApiPath = apiV1Path + '/tunnels';
const limitsApiPath = apiV1Path + '/userlimits';
const endpointsApiSubPath = '/endpoints';
const portsApiSubPath = '/ports';
const clustersApiPath = apiV1Path + '/clusters';
const tunnelAuthentication = 'Authorization';
const checkAvailablePath = '/checkAvailability';

function comparePorts(a: TunnelPort, b: TunnelPort) {
    return (a.portNumber ?? Number.MAX_SAFE_INTEGER) - (b.portNumber ?? Number.MAX_SAFE_INTEGER);
}

function parseDate(value?: string | Date) {
    return typeof value === 'string' ? new Date(Date.parse(value)) : value;
}

/**
 * Fixes Tunnel properties of type Date that were deserialized as strings.
 */
function parseTunnelDates(tunnel: Tunnel | null) {
    if (!tunnel) return;
    tunnel.created = parseDate(tunnel.created);
    if (tunnel.status) {
        tunnel.status.lastHostConnectionTime = parseDate(tunnel.status.lastHostConnectionTime);
        tunnel.status.lastClientConnectionTime = parseDate(tunnel.status.lastClientConnectionTime);
    }
}

/**
 * Fixes TunnelPort properties of type Date that were deserialized as strings.
 */
function parseTunnelPortDates(port: TunnelPort | null) {
    if (!port) return;
    if (port.status) {
        port.status.lastClientConnectionTime = parseDate(port.status.lastClientConnectionTime);
    }
}

const manageAccessTokenScope = [TunnelAccessScopes.Manage];
const hostAccessTokenScope = [TunnelAccessScopes.Host];
const managePortsAccessTokenScopes = [
    TunnelAccessScopes.Manage,
    TunnelAccessScopes.ManagePorts,
    TunnelAccessScopes.Host,
];
const readAccessTokenScopes = [
    TunnelAccessScopes.Manage,
    TunnelAccessScopes.ManagePorts,
    TunnelAccessScopes.Host,
    TunnelAccessScopes.Connect,
];

export class TunnelManagementHttpClient implements TunnelManagementClient {
    public additionalRequestHeaders?: { [header: string]: string };

    private readonly baseAddress: string;
    private readonly userTokenCallback: () => Promise<string | null>;
    private readonly userAgents: string;

    public trace: (msg: string) => void = (msg) => {};

    /**
     * Initializes a new instance of the `TunnelManagementHttpClient` class
     * with a client authentication callback, service URI, and HTTP handler.
     *
     * @param userAgent { name, version } object or a comment string to use as the User-Agent header.
     * @param userTokenCallback Optional async callback for retrieving a client authentication
     * header value with access token, for AAD or GitHub user authentication. This may be omitted
     * for anonymous tunnel clients, or if tunnel access tokens will be specified via
     * `TunnelRequestOptions.accessToken`.
     * @param tunnelServiceUri Optional tunnel service URI (not including any path). Defaults to
     * the global tunnel service URI.
     * @param httpsAgent Optional agent that will be invoked for HTTPS requests to the tunnel
     * service.
     */
    public constructor(
        userAgents: (ProductHeaderValue | string)[] | ProductHeaderValue | string,
        userTokenCallback?: () => Promise<string | null>,
        tunnelServiceUri?: string,
        public readonly httpsAgent?: https.Agent,
    ) {
        if (!userAgents) {
            throw new TypeError('User agent must be provided.');
        }

        if (Array.isArray(userAgents)) {
            if (userAgents.length === 0) {
                throw new TypeError('User agents cannot be empty.');
            }
            let combinedUserAgents = '';

            userAgents.forEach((userAgent) => {
                if (typeof userAgent !== 'string') {
                    if (!userAgent.name) {
                        throw new TypeError('Invalid user agent. The name must be provided.');
                    }

                    if (typeof userAgent.name !== 'string') {
                        throw new TypeError('Invalid user agent. The name must be a string.');
                    }

                    if (userAgent.version && typeof userAgent.version !== 'string') {
                        throw new TypeError('Invalid user agent. The version must be a string.');
                    }
                    combinedUserAgents = `${combinedUserAgents}${
                        userAgent.name
                    }/${userAgent.version ?? 'unknown'} `;
                } else {
                    combinedUserAgents = `${combinedUserAgents}${userAgent} `;
                }
            });
            this.userAgents = combinedUserAgents.trim();
        } else if (typeof userAgents !== 'string') {
            if (!userAgents.name) {
                throw new TypeError('Invalid user agent. The name must be provided.');
            }

            if (typeof userAgents.name !== 'string') {
                throw new TypeError('Invalid user agent. The name must be a string.');
            }

            if (userAgents.version && typeof userAgents.version !== 'string') {
                throw new TypeError('Invalid user agent. The version must be a string.');
            }
            this.userAgents = `${userAgents.name}/${userAgents.version ?? 'unknown'}`;
        } else {
            this.userAgents = userAgents;
        }

        this.userTokenCallback = userTokenCallback ?? (() => Promise.resolve(null));

        if (!tunnelServiceUri) {
            tunnelServiceUri = TunnelServiceProperties.production.serviceUri;
        }

        const parsedUri = new URL(tunnelServiceUri);
        if (!parsedUri || parsedUri.pathname !== '/') {
            throw new TypeError(`Invalid tunnel service URI: ${tunnelServiceUri}`);
        }

        this.baseAddress = tunnelServiceUri;
    }

    public async listTunnels(
        clusterId?: string,
        domain?: string,
        options?: TunnelRequestOptions,
    ): Promise<Tunnel[]> {
        const queryParams = [clusterId ? null : 'global=true', domain ? `domain=${domain}` : null];
        const query = queryParams.filter((p) => !!p).join('&');
        const results = (await this.sendRequest<Tunnel[]>(
            'GET',
            clusterId,
            tunnelsApiPath,
            query,
            options,
        ))!;
        results.forEach(parseTunnelDates);
        return results;
    }

    public async getTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel | null> {
        const result = await this.sendTunnelRequest<Tunnel | null>(
            'GET',
            tunnel,
            readAccessTokenScopes,
            undefined,
            undefined,
            options,
        );
        parseTunnelDates(result);
        return result;
    }

    public async createTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel> {
        const tunnelId = tunnel.tunnelId;
        if (tunnelId) {
            throw new Error('An ID may not be specified when creating a tunnel.');
        }

        tunnel = this.convertTunnelForRequest(tunnel);
        const result = (await this.sendRequest<Tunnel>(
            'POST',
            tunnel.clusterId,
            tunnelsApiPath,
            undefined,
            options,
            tunnel,
        ))!;
        parseTunnelDates(result);
        return result;
    }

    public async updateTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel> {
        const result = (await this.sendTunnelRequest<Tunnel>(
            'PUT',
            tunnel,
            manageAccessTokenScope,
            undefined,
            undefined,
            options,
            this.convertTunnelForRequest(tunnel),
        ))!;

        if (!options?.tokenScopes) {
            // If no new tokens were requested in the update, preserve any existing
            // access tokens in the resulting tunnel object.
            result.accessTokens = tunnel.accessTokens;
        }

        parseTunnelDates(result);
        return result;
    }

    public async deleteTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<boolean> {
        return await this.sendTunnelRequest<boolean>(
            'DELETE',
            tunnel,
            manageAccessTokenScope,
            undefined,
            undefined,
            options,
            undefined,
            true,
        );
    }

    public async updateTunnelEndpoint(
        tunnel: Tunnel,
        endpoint: TunnelEndpoint,
        options?: TunnelRequestOptions,
    ): Promise<TunnelEndpoint> {
        const path = `${endpointsApiSubPath}/${endpoint.hostId}/${endpoint.connectionMode}`;
        const result = (await this.sendTunnelRequest<TunnelEndpoint>(
            'PUT',
            tunnel,
            hostAccessTokenScope,
            path,
            undefined,
            options,
            endpoint,
        ))!;

        if (tunnel.endpoints) {
            // Also update the endpoint in the local tunnel object.
            tunnel.endpoints = tunnel.endpoints
                .filter(
                    (e) =>
                        e.hostId !== endpoint.hostId ||
                        e.connectionMode !== endpoint.connectionMode,
                )
                .concat(result);
        }

        return result;
    }

    public async deleteTunnelEndpoints(
        tunnel: Tunnel,
        hostId: string,
        connectionMode?: TunnelConnectionMode,
        options?: TunnelRequestOptions,
    ): Promise<boolean> {
        const path =
            connectionMode == null
                ? `${endpointsApiSubPath}/${hostId}`
                : `${endpointsApiSubPath}/${hostId}/${connectionMode}`;
        const result = await this.sendTunnelRequest<boolean>(
            'DELETE',
            tunnel,
            hostAccessTokenScope,
            path,
            undefined,
            options,
            undefined,
            true,
        );

        if (result && tunnel.endpoints) {
            // Also delete the endpoint in the local tunnel object.
            tunnel.endpoints = tunnel.endpoints.filter(
                (e) => e.hostId !== hostId || e.connectionMode !== connectionMode,
            );
        }

        return result;
    }

    public async listUserLimits(): Promise<NamedRateStatus[]> {
        const results = await this.sendRequest<NamedRateStatus[]>(
            'GET',
            undefined,
            limitsApiPath,
            undefined,
            undefined,
        );
        return results || [];
    }

    public async listTunnelPorts(
        tunnel: Tunnel,
        options?: TunnelRequestOptions,
    ): Promise<TunnelPort[]> {
        const results = (await this.sendTunnelRequest<TunnelPort[]>(
            'GET',
            tunnel,
            readAccessTokenScopes,
            portsApiSubPath,
            undefined,
            options,
        ))!;
        results.forEach(parseTunnelPortDates);
        return results;
    }

    public async getTunnelPort(
        tunnel: Tunnel,
        portNumber: number,
        options?: TunnelRequestOptions,
    ): Promise<TunnelPort | null> {
        const path = `${portsApiSubPath}/${portNumber}`;
        const result = await this.sendTunnelRequest<TunnelPort>(
            'GET',
            tunnel,
            readAccessTokenScopes,
            path,
            undefined,
            options,
        );
        parseTunnelPortDates(result);
        return result;
    }

    public async createTunnelPort(
        tunnel: Tunnel,
        tunnelPort: TunnelPort,
        options?: TunnelRequestOptions,
    ): Promise<TunnelPort> {
        tunnelPort = this.convertTunnelPortForRequest(tunnel, tunnelPort);
        const result = (await this.sendTunnelRequest<TunnelPort>(
            'POST',
            tunnel,
            managePortsAccessTokenScopes,
            portsApiSubPath,
            undefined,
            options,
            tunnelPort,
        ))!;

        if (tunnel.ports) {
            // Also add the port to the local tunnel object.
            tunnel.ports = tunnel.ports
                .filter((p) => p.portNumber !== tunnelPort.portNumber)
                .concat(result)
                .sort(comparePorts);
        }

        parseTunnelPortDates(result);
        return result;
    }

    public async updateTunnelPort(
        tunnel: Tunnel,
        tunnelPort: TunnelPort,
        options?: TunnelRequestOptions,
    ): Promise<TunnelPort> {
        if (tunnelPort.clusterId && tunnel.clusterId && tunnelPort.clusterId !== tunnel.clusterId) {
            throw new Error('Tunnel port cluster ID is not consistent.');
        }

        const portNumber = tunnelPort.portNumber;
        const path = `${portsApiSubPath}/${portNumber}`;
        tunnelPort = this.convertTunnelPortForRequest(tunnel, tunnelPort);
        const result = (await this.sendTunnelRequest<TunnelPort>(
            'PUT',
            tunnel,
            managePortsAccessTokenScopes,
            path,
            undefined,
            options,
            tunnelPort,
        ))!;

        if (tunnel.ports) {
            // Also update the port in the local tunnel object.
            tunnel.ports = tunnel.ports
                .filter((p) => p.portNumber !== tunnelPort.portNumber)
                .concat(result)
                .sort(comparePorts);
        }

        if (!options?.tokenScopes) {
            // If no new tokens were requested in the update, preserve any existing
            // access tokens in the resulting port object.
            result.accessTokens = tunnelPort.accessTokens;
        }

        parseTunnelPortDates(result);
        return result;
    }

    public async deleteTunnelPort(
        tunnel: Tunnel,
        portNumber: number,
        options?: TunnelRequestOptions,
    ): Promise<boolean> {
        const path = `${portsApiSubPath}/${portNumber}`;
        const result = await this.sendTunnelRequest<boolean>(
            'DELETE',
            tunnel,
            managePortsAccessTokenScopes,
            path,
            undefined,
            options,
            undefined,
            true,
        );

        if (result && tunnel.ports) {
            // Also delete the port in the local tunnel object.
            tunnel.ports = tunnel.ports
                .filter((p) => p.portNumber !== portNumber)
                .sort(comparePorts);
        }

        return result;
    }

    public async listClusters(): Promise<ClusterDetails[]> {
        return (await this.sendRequest<ClusterDetails[]>(
            'GET',
            undefined,
            clustersApiPath,
            undefined,
            undefined,
            undefined,
            false,
        ))!;
    }

    /**
     * Sends an HTTP request to the tunnel management API, targeting a specific tunnel.
     * This protected method enables subclasses to support additional tunnel management APIs.
     * @param method HTTP request method.
     * @param tunnel Tunnel that the request is targeting.
     * @param accessTokenScopes Required array of access scopes for tokens in `tunnel.accessTokens`
     * that could be used to authorize the request.
     * @param path Optional request sub-path relative to the tunnel.
     * @param query Optional query string to append to the request.
     * @param options Request options.
     * @param body Optional request body object.
     * @param allowNotFound If true, a 404 response is returned as a null or false result
     * instead of an error.
     * @returns Result of the request.
     */
    protected async sendTunnelRequest<TResult>(
        method: Method,
        tunnel: Tunnel,
        accessTokenScopes: string[],
        path?: string,
        query?: string,
        options?: TunnelRequestOptions,
        body?: object,
        allowNotFound?: boolean,
    ): Promise<NullableIfNotBoolean<TResult>> {
        const uri = this.buildUriForTunnel(tunnel, path, query, options);
        const config = await this.getAxiosRequestConfig(tunnel, options, accessTokenScopes);
        const result = await this.request<TResult>(method, uri, body, config, allowNotFound);
        return result;
    }

    /**
     * Sends an HTTP request to the tunnel management API.
     * This protected method enables subclasses to support additional tunnel management APIs.
     * @param method HTTP request method.
     * @param clusterId Optional tunnel service cluster ID to direct the request to. If unspecified,
     * the request will use the global traffic-manager to find the nearest cluster.
     * @param path Required request path.
     * @param query Optional query string to append to the request.
     * @param options Request options.
     * @param body Optional request body object.
     * @param allowNotFound If true, a 404 response is returned as a null or false result
     * instead of an error.
     * @returns Result of the request.
     */
    protected async sendRequest<TResult>(
        method: Method,
        clusterId: string | undefined,
        path: string,
        query?: string,
        options?: TunnelRequestOptions,
        body?: object,
        allowNotFound?: boolean,
    ): Promise<NullableIfNotBoolean<TResult>> {
        const uri = this.buildUri(clusterId, path, query, options);
        const config = await this.getAxiosRequestConfig(undefined, options);
        const result = await this.request<TResult>(method, uri, body, config, allowNotFound);
        return result;
    }

    public async checkNameAvailablility(tunnelName: string): Promise<boolean> {
        tunnelName = encodeURI(tunnelName);
        const uri = this.buildUri(
            undefined,
            `${tunnelsApiPath}/${tunnelName}${checkAvailablePath}`,
        );
        const config: AxiosRequestConfig = {
            httpsAgent: this.httpsAgent,
        };
        return await this.request<boolean>('GET', uri, undefined, config);
    }

    private getResponseErrorMessage(error: AxiosError) {
        let errorMessage = '';
        if (error.response?.data) {
            const problemDetails: ProblemDetails = error.response.data;
            if (problemDetails.title || problemDetails.detail) {
                errorMessage = `Tunnel service error: ${problemDetails.title}`;
                if (problemDetails.detail) {
                    errorMessage += ' ' + problemDetails.detail;
                }
                if (problemDetails.errors) {
                    errorMessage += JSON.stringify(problemDetails.errors);
                }
            }
        }

        if (!errorMessage) {
            if (error?.response) {
                errorMessage =
                    'Tunnel service returned status code: ' +
                    `${error.response.status} ${error.response.statusText}`;
            } else {
                errorMessage = error?.message ?? error ?? 'Unknown tunnel service request error.';
            }
        }

        const requestIdHeaderName = 'VsSaaS-Request-Id';
        if (error.response?.headers && error.response.headers[requestIdHeaderName]) {
            errorMessage += `\nRequest ID: ${error.response.headers[requestIdHeaderName]}`;
        }

        return errorMessage;
    }

    // Helper functions
    private buildUri(
        clusterId: string | undefined,
        path: string,
        query?: string,
        options?: TunnelRequestOptions,
    ) {
        let baseAddress = this.baseAddress;

        if (clusterId) {
            const url = new URL(baseAddress);
            const portNumber = parseInt(url.port, 10);
            if (url.hostname !== 'localhost' && !url.hostname.startsWith(`${clusterId}.`)) {
                // A specific cluster ID was specified (while not running on localhost).
                // Prepend the cluster ID to the hostname, and optionally strip a global prefix.
                url.hostname = `${clusterId}.${url.hostname}`.replace('global.', '');
                baseAddress = url.toString();
            } else if (
                url.protocol === 'https:' &&
                clusterId.startsWith('localhost') &&
                portNumber % 10 > 0
            ) {
                // Local testing simulates clusters by running the service on multiple ports.
                // Change the port number to match the cluster ID suffix.
                const clusterNumber = parseInt(clusterId.substring('localhost'.length), 10);
                if (clusterNumber > 0 && clusterNumber < 10) {
                    url.port = (portNumber - (portNumber % 10) + clusterNumber).toString();
                    baseAddress = url.toString();
                }
            }
        }

        baseAddress = `${baseAddress.replace(/\/$/, '')}${path}`;

        const optionsQuery = this.tunnelRequestOptionsToQueryString(options, query);
        if (optionsQuery) {
            baseAddress += `?${optionsQuery}`;
        }

        return baseAddress;
    }

    private buildUriForTunnel(
        tunnel: Tunnel,
        path?: string,
        query?: string,
        options?: TunnelRequestOptions,
    ) {
        let tunnelPath = '';
        if (tunnel.clusterId && tunnel.tunnelId) {
            tunnelPath = `${tunnelsApiPath}/${tunnel.tunnelId}`;
        } else {
            if (!tunnel.name) {
                throw new Error(
                    'Tunnel object must include either a name or tunnel ID and cluster ID.',
                );
            }
            tunnelPath = `${tunnelsApiPath}/${tunnel.name}`;
        }

        if (options?.additionalQueryParameters) {
            for (const [paramName, paramValue] of Object.entries(options.additionalQueryParameters)) {
                if (query) {
                    query += `&${paramName}=${paramValue}`;
                } else {
                    query = `${paramName}=${paramValue}`;
                }
            }
        }

        return this.buildUri(tunnel.clusterId, tunnelPath + (path ? path : ''), query, options);
    }

    private async getAxiosRequestConfig(
        tunnel?: Tunnel,
        options?: TunnelRequestOptions,
        accessTokenScopes?: string[],
    ): Promise<AxiosRequestConfig> {
        // Get access token header
        const headers: { [name: string]: string } = {};

        if (options && options.accessToken) {
            TunnelAccessTokenProperties.validateTokenExpiration(options.accessToken);
            headers[
                tunnelAuthentication
            ] = `${TunnelAuthenticationSchemes.tunnel} ${options.accessToken}`;
        }

        if (!(tunnelAuthentication in headers) && this.userTokenCallback) {
            const token = await this.userTokenCallback();
            if (token) {
                headers[tunnelAuthentication] = token;
            }
        }

        if (!(tunnelAuthentication in headers)) {
            const accessToken = TunnelAccessTokenProperties.getTunnelAccessToken(
                tunnel,
                accessTokenScopes,
            );
            if (accessToken) {
                headers[
                    tunnelAuthentication
                ] = `${TunnelAuthenticationSchemes.tunnel} ${accessToken}`;
            }
        }

        const copyAdditionalHeaders = (additionalHeaders?: { [name: string]: string }) => {
            if (additionalHeaders) {
                for (const [headerName, headerValue] of Object.entries(additionalHeaders)) {
                    headers[headerName] = headerValue;
                }
            }
        };
        copyAdditionalHeaders(this.additionalRequestHeaders);
        copyAdditionalHeaders(options?.additionalHeaders);

        const userAgentPrefix = headers['User-Agent'] ? headers['User-Agent'] + ' ' : '';

        headers['User-Agent'] = `${userAgentPrefix}${this.userAgents} ${tunnelSdkUserAgent}`;

        // Get axios config
        const config: AxiosRequestConfig = {
            headers,
            ...(this.httpsAgent && { httpsAgent: this.httpsAgent }),
        };

        if (options?.followRedirects === false) {
            config.maxRedirects = 0;
        }

        return config;
    }

    private convertTunnelForRequest(tunnel: Tunnel): Tunnel {
        const convertedTunnel: Tunnel = {
            name: tunnel.name,
            domain: tunnel.domain,
            description: tunnel.description,
            tags: tunnel.tags,
            options: tunnel.options,
            accessControl: !tunnel.accessControl
                ? undefined
                : { entries: tunnel.accessControl.entries.filter((ace) => !ace.isInherited) },
            endpoints: tunnel.endpoints,
            ports: tunnel.ports?.map((p) => this.convertTunnelPortForRequest(tunnel, p)),
        };

        return convertedTunnel;
    }

    private convertTunnelPortForRequest(tunnel: Tunnel, tunnelPort: TunnelPort): TunnelPort {
        if (tunnelPort.clusterId && tunnel.clusterId && tunnelPort.clusterId !== tunnel.clusterId) {
            throw new Error('Tunnel port cluster ID does not match tunnel.');
        }

        if (tunnelPort.tunnelId && tunnel.tunnelId && tunnelPort.tunnelId !== tunnel.tunnelId) {
            throw new Error('Tunnel port tunnel ID does not match tunnel.');
        }

        return {
            portNumber: tunnelPort.portNumber,
            protocol: tunnelPort.protocol,
            isDefault: tunnelPort.isDefault,
            description: tunnelPort.description,
            tags: tunnelPort.tags,
            sshUser: tunnelPort.sshUser,
            options: tunnelPort.options,
            accessControl: !tunnelPort.accessControl
                ? undefined
                : { entries: tunnelPort.accessControl.entries.filter((ace) => !ace.isInherited) },
        };
    }

    private tunnelRequestOptionsToQueryString(
        options?: TunnelRequestOptions,
        additionalQuery?: string,
    ) {
        const queryOptions: { [name: string]: string[] } = {};
        const queryItems = [];

        if (options) {
            if (options.includePorts) {
                queryOptions.includePorts = ['true'];
            }

            if (options.includeAccessControl) {
                queryOptions.includeAccessControl = ['true'];
            }

            if (options.tokenScopes) {
                TunnelAccessControl.validateScopes(options.tokenScopes, undefined, true);
                queryOptions.tokenScopes = options.tokenScopes;
            }

            if (options.forceRename) {
                queryOptions.forceRename = ['true'];
            }

            if (options.tags) {
                queryOptions.tags = options.tags;
                if (options.requireAllTags) {
                    queryOptions.allTags = ['true'];
                }
            }

            if (options.limit) {
                queryOptions.limit = [options.limit.toString()];
            }

            queryItems.push(
                ...Object.keys(queryOptions).map((key) => {
                    const value = queryOptions[key];
                    return `${key}=${value.map(encodeURIComponent).join(',')}`;
                }),
            );
        }

        if (additionalQuery) {
            queryItems.push(additionalQuery);
        }

        const queryString = queryItems.join('&');
        return queryString;
    }

    /**
     * Makes an HTTP request using Axios, while tracing request and response details.
     */
    private async request<TResult>(
        method: Method,
        uri: string,
        data: any,
        config: AxiosRequestConfig,
        allowNotFound?: boolean,
    ): Promise<NullableIfNotBoolean<TResult>> {
        this.trace(`${method} ${uri}`);
        this.traceHeaders(config.headers);
        this.traceContent(data);

        const traceResponse = (response: AxiosResponse) => {
            this.trace(`${response.status} ${response.statusText}`);
            this.traceHeaders(response.headers);
            this.traceContent(response.data);
        };

        try {
            config.url = uri;
            config.method = method;
            config.data = data;

            const response = await axios.request<TResult>(config);
            traceResponse(response);

            // This assumes that TResult is always boolean for DELETE requests.
            return <NullableIfNotBoolean<TResult>>(method === 'DELETE' ? true : response.data);
        } catch (e) {
            if (!(e instanceof Error) || !(e as AxiosError).isAxiosError) throw e;
            const requestError = e as AxiosError;
            if (requestError.response) {
                traceResponse(requestError.response);

                if (allowNotFound && requestError.response.status === 404) {
                    return <NullableIfNotBoolean<TResult>>(method === 'DELETE' ? false : null);
                }
            }

            requestError.message = this.getResponseErrorMessage(requestError);

            // Axios errors have too much redundant detail! Delete some of it.
            delete requestError.request;
            if (requestError.response) {
                delete requestError.config.httpAgent;
                delete requestError.config.httpsAgent;
                delete requestError.response.request;
            }

            throw requestError;
        }
    }

    private traceHeaders(headers: { [key: string]: unknown }): void {
        for (const [headerName, headerValue] of Object.entries(headers)) {
            if (headerName === 'Authorization') {
                this.traceAuthorizationHeader(headerName, headerValue as string);
                return;
            }

            this.trace(`${headerName}: ${headerValue ?? ''}`);
        }
    }

    private traceAuthorizationHeader(key: string, value: string): void {
        if (typeof value !== 'string') return;

        const spaceIndex = value.indexOf(' ');
        if (spaceIndex < 0) {
            this.trace(`${key}: [${value.length}]`);
            return;
        }

        const scheme = value.substring(0, spaceIndex);
        const token = value.substring(spaceIndex + 1);

        if (scheme.toLowerCase() === TunnelAuthenticationSchemes.tunnel.toLowerCase()) {
            const tokenProperties = TunnelAccessTokenProperties.tryParse(token);
            if (tokenProperties) {
                this.trace(`${key}: ${scheme} <${tokenProperties}>`);
                return;
            }
        }

        this.trace(`${key}: ${scheme} <token>`);
    }

    private traceContent(data: any) {
        if (typeof data === 'object') {
            data = JSON.stringify(data, undefined, '  ');
        }

        if (typeof data === 'string') {
            this.trace(TunnelManagementHttpClient.replaceTokensInContent(data));
        }
    }

    private static replaceTokensInContent(content: string): string {
        const tokenRegex = /"(eyJ[a-zA-z0-9\-_]+\.[a-zA-z0-9\-_]+\.[a-zA-z0-9\-_]+)"/;

        let match = tokenRegex.exec(content);
        while (match) {
            let token = match[1];
            const tokenProperties = TunnelAccessTokenProperties.tryParse(token);
            token = tokenProperties?.toString() ?? 'token';
            content =
                content.substring(0, match.index + 1) +
                '<' +
                token +
                '>' +
                content.substring(match.index + match[0].length - 1);
            match = tokenRegex.exec(content);
        }

        return content;
    }
}