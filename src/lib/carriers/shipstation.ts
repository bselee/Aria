/**
 * @file    shipstation.ts
 * @purpose Interacts with the ShipStation API to fetch shipments and calculate box usage
 * @author  Agent
 * @created 2026-03-03
 * @updated 2026-03-03
 * @deps    node-fetch or native fetch
 * @env     SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET
 */

const SHIPSTATION_BASE_URL = 'https://ssapi.shipstation.com'

export interface BoxUsageReport {
    [boxKey: string]: {
        count: number
        name: string
        dimensions?: { length: number; width: number; height: number; units: string }
    }
}

/**
 * Generates the Basic Auth header required for the ShipStation API
 */
function getAuthHeader(): string {
    const apiKey = process.env.SHIPSTATION_API_KEY
    const apiSecret = process.env.SHIPSTATION_API_SECRET

    if (!apiKey || !apiSecret) {
        throw new Error('Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET in environment variables')
    }

    const credentials = `${apiKey}:${apiSecret}`
    return `Basic ${Buffer.from(credentials).toString('base64')}`
}

/**
 * Fetches all shipments within a specific date range from ShipStation
 * Handles pagination automatically.
 *
 * @param startDate - The beginning of the date range (YYYY-MM-DD or ISO string)
 * @param endDate   - The end of the date range (YYYY-MM-DD or ISO string)
 */
export async function fetchShipments(startDate: string, endDate: string) {
    let allShipments: any[] = []
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
        const url = new URL(`${SHIPSTATION_BASE_URL}/shipments`)
        url.searchParams.append('createDateStart', startDate)
        url.searchParams.append('createDateEnd', endDate)
        url.searchParams.append('pageSize', '500') // Max page size
        url.searchParams.append('page', page.toString())

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                Authorization: getAuthHeader(),
                'Content-Type': 'application/json',
            },
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`ShipStation API Error (${response.status}): ${errorText}`)
        }

        const data = await response.json()
        allShipments = allShipments.concat(data.shipments || [])

        totalPages = data.pages || 1
        page++
    }

    return allShipments
}

/**
 * Calculates box usage statistics from a list of shipments
 * Matches by packageCode or dimensions
 * 
 * @param startDate - Period start
 * @param endDate   - Period end
 */
export async function calculateBoxUsage(startDate: string, endDate: string): Promise<BoxUsageReport> {
    const shipments = await fetchShipments(startDate, endDate)
    const report: BoxUsageReport = {}

    for (const shipment of shipments) {
        // Determine a unique key for the box
        // Could be the packageCode or the physical dimensions
        let key = shipment.packageCode || 'Unknown'
        let name = shipment.packageCode || 'Unknown Box'

        // If we have dimensions, we can use them to identify custom boxes
        if (shipment.dimensions && shipment.dimensions.length > 0) {
            const { length, width, height, units } = shipment.dimensions
            if (length > 0 && width > 0 && height > 0) {
                key = `${length}x${width}x${height} ${units}`
                name = `${length}x${width}x${height} ${units} Box`
            }
        }

        if (!report[key]) {
            report[key] = {
                name,
                count: 0,
                dimensions: shipment.dimensions,
            }
        }

        report[key].count++
    }

    return report
}
